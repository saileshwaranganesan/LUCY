#!/usr/bin/env python3
"""
Kokoro-82M ONNX Speech Synthesis Worker for L.U.C.Y.
Provides isolated, resource-efficient, on-demand local text-to-speech.

Features:
- Separate worker process: does not block the UI or wake-word detection.
- Memory-aware lifecycle: on-demand loading, configurable idle timeout, explicit unloading.
- Audio synthesis using Kokoro-82M INT8 quantized ONNX weights and ONNX Runtime CPU.
- Real-time performance monitoring (RSS RAM, CPU, latency, audio duration).
- JSON line-delimited IPC protocol over stdin/stdout.
"""

import sys
import os
import json
import time
import io
import gc
import threading
import psutil

try:
    import soundfile as sf
    import onnxruntime as rt
    from kokoro_onnx import Kokoro
    HAS_DEPS = True
except ImportError as e:
    HAS_DEPS = False
    IMPORT_ERROR = str(e)

# Configuration defaults
def _find_default_model_path():
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "..", "models", "kokoro", "kokoro-v1.0.int8.onnx"),
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "models", "kokoro", "kokoro-v1.0.int8.onnx"),
        os.path.join(os.getcwd(), "models", "kokoro", "kokoro-v1.0.int8.onnx"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return os.path.abspath(c)
    return os.path.abspath(candidates[0])

def _find_default_voice_path():
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "..", "models", "kokoro", "voices.bin"),
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "models", "kokoro", "voices.bin"),
        os.path.join(os.path.dirname(__file__), "..", "..", "models", "kokoro", "af_bella.bin"),
        os.path.join(os.getcwd(), "models", "kokoro", "voices.bin"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return os.path.abspath(c)
    return os.path.abspath(candidates[0])

DEFAULT_MODEL_PATH = _find_default_model_path()
DEFAULT_VOICE_PATH = _find_default_voice_path()
DEFAULT_VOICE_NAME = "af_bella"

class KokoroWorker:
    def __init__(self):
        self.proc = psutil.Process(os.getpid())
        self.kokoro = None
        self.session = None
        self.model_path = os.path.abspath(DEFAULT_MODEL_PATH)
        self.voice_path = os.path.abspath(DEFAULT_VOICE_PATH)
        self.default_voice = DEFAULT_VOICE_NAME
        self.threads = max(2, min(6, (os.cpu_count() or 4) // 2))
        self.is_loaded = False
        self.is_synthesizing = False
        self.cancel_requested = False
        self.lock = threading.Lock()

    def get_memory_info(self):
        rss = self.proc.memory_info().rss / (1024 * 1024)
        sys_mem = psutil.virtual_memory()
        return {
            "rss_mb": round(rss, 2),
            "system_available_mb": round(sys_mem.available / (1024 * 1024), 2),
            "system_percent": sys_mem.percent
        }

    def load_model(self, model_path=None, voice_path=None, threads=None):
        with self.lock:
            if self.is_loaded and self.kokoro is not None:
                return {
                    "status": "ok",
                    "action": "load",
                    "already_loaded": True,
                    "memory": self.get_memory_info()
                }

            if not HAS_DEPS:
                return {
                    "status": "error",
                    "error": f"Dependencies not available: {IMPORT_ERROR}"
                }

            if model_path:
                self.model_path = os.path.abspath(model_path)
            if voice_path:
                self.voice_path = os.path.abspath(voice_path)
            if threads:
                self.threads = int(threads)

            if not os.path.exists(self.model_path):
                return {
                    "status": "error",
                    "error": f"Kokoro ONNX model file not found at: {self.model_path}"
                }
            if not os.path.exists(self.voice_path):
                return {
                    "status": "error",
                    "error": f"Voice embeddings file not found at: {self.voice_path}"
                }

            t0 = time.perf_counter()
            opts = rt.SessionOptions()
            opts.intra_op_num_threads = self.threads
            opts.inter_op_num_threads = max(1, self.threads // 2)
            opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_ALL
            opts.execution_mode = rt.ExecutionMode.ORT_SEQUENTIAL

            self.session = rt.InferenceSession(self.model_path, sess_options=opts, providers=["CPUExecutionProvider"])
            self.kokoro = Kokoro.from_session(self.session, self.voice_path)
            t_load = (time.perf_counter() - t0) * 1000

            self.is_loaded = True
            voices = self.kokoro.get_voices()

            return {
                "status": "ok",
                "action": "load",
                "load_time_ms": round(t_load, 1),
                "threads": self.threads,
                "voices": voices,
                "memory": self.get_memory_info()
            }

    def unload_model(self):
        with self.lock:
            if not self.is_loaded:
                return {
                    "status": "ok",
                    "action": "unload",
                    "already_unloaded": True,
                    "memory": self.get_memory_info()
                }

            t0 = time.perf_counter()
            self.kokoro = None
            self.session = None
            gc.collect()
            t_unload = (time.perf_counter() - t0) * 1000
            self.is_loaded = False

            return {
                "status": "ok",
                "action": "unload",
                "unload_time_ms": round(t_unload, 1),
                "memory": self.get_memory_info()
            }

    def synthesize(self, text, voice=None, speed=1.0, lang="en-us", output_path=None):
        if not self.is_loaded:
            # Auto-load on-demand
            load_res = self.load_model()
            if load_res.get("status") != "ok":
                return load_res

        self.cancel_requested = False
        self.is_synthesizing = True
        chosen_voice = voice or self.default_voice

        # Check if chosen voice is available in loaded voices, otherwise fallback to first available
        avail = self.kokoro.get_voices()
        if chosen_voice not in avail and avail:
            chosen_voice = avail[0]

        t0 = time.perf_counter()
        try:
            samples, sr = self.kokoro.create(
                text=text,
                voice=chosen_voice,
                speed=float(speed),
                lang=lang
            )

            if self.cancel_requested:
                return {
                    "status": "cancelled",
                    "text": text
                }

            latency_ms = (time.perf_counter() - t0) * 1000
            audio_dur_s = len(samples) / sr
            rtf = (latency_ms / 1000.0) / audio_dur_s if audio_dur_s > 0 else 0

            # Encode to WAV (either write to specified file or encode in-memory)
            if output_path:
                out_dir = os.path.dirname(os.path.abspath(output_path))
                os.makedirs(out_dir, exist_ok=True)
                sf.write(output_path, samples, sr)
                audio_ref = output_path
            else:
                import base64
                buf = io.BytesIO()
                sf.write(buf, samples, sr, format="WAV")
                buf.seek(0)
                audio_ref = "data:audio/wav;base64," + base64.b64encode(buf.read()).decode("ascii")

            return {
                "status": "ok",
                "action": "synthesize",
                "audio": audio_ref,
                "is_file": bool(output_path),
                "duration_s": round(audio_dur_s, 2),
                "latency_ms": round(latency_ms, 1),
                "rtf": round(rtf, 3),
                "sample_rate": sr,
                "samples_count": len(samples),
                "voice": chosen_voice,
                "memory": self.get_memory_info()
            }
        except Exception as e:
            return {
                "status": "error",
                "error": str(e)
            }
        finally:
            self.is_synthesizing = False

    def cancel(self):
        self.cancel_requested = True
        return {
            "status": "ok",
            "action": "cancel",
            "message": "Cancellation flag set"
        }

    def status(self):
        return {
            "status": "ok",
            "action": "status",
            "is_loaded": self.is_loaded,
            "is_synthesizing": self.is_synthesizing,
            "threads": self.threads,
            "model_path": self.model_path,
            "voice_path": self.voice_path,
            "memory": self.get_memory_info()
        }

def run_loop():
    worker = KokoroWorker()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            res = {"status": "error", "error": f"Invalid JSON: {e}"}
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
            continue

        cmd = req.get("cmd", "")
        req_id = req.get("_reqId")

        if cmd == "ping":
            res = {"status": "ok", "action": "ping", "memory": worker.get_memory_info()}
        elif cmd == "status":
            res = worker.status()
        elif cmd == "load":
            res = worker.load_model(
                model_path=req.get("model_path"),
                voice_path=req.get("voice_path"),
                threads=req.get("threads")
            )
        elif cmd == "unload":
            res = worker.unload_model()
        elif cmd == "synthesize":
            res = worker.synthesize(
                text=req.get("text", ""),
                voice=req.get("voice"),
                speed=req.get("speed", 1.0),
                lang=req.get("lang", "en-us"),
                output_path=req.get("output_path")
            )
        elif cmd == "cancel":
            res = worker.cancel()
        elif cmd == "exit":
            res = {"status": "ok", "action": "exit"}
            if req_id is not None:
                res["_reqId"] = req_id
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
            break
        else:
            res = {"status": "error", "error": f"Unknown command: {cmd}", "action": cmd}

        if req_id is not None:
            res["_reqId"] = req_id
        if "action" not in res:
            res["action"] = cmd

        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    run_loop()
