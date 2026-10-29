# Authoritative Project Documentation Map

When working in the L.U.C.Y. codebase, always consult ground-truth documentation before proposing changes or making architectural decisions:

1. **System Baseline & Inventory**: `PHASE0_BASELINE_REPORT.md` (comprehensive architecture, entry points, toolchain).
2. **Defect Tracking & Historical Decisions**: `PHASE0_DEFECT_REGISTER.md` (active and resolved defect codes like DEF-PKG-001, DEF-CORE-001).
3. **Dependency Architecture**: `PHASE0_DEPENDENCY_MAP.md` (component relationships, worker dependencies, IPC channels).
4. **Verification Matrix**: `PHASE0_VERIFICATION_MATRIX.md` (10-track test verification matrix).
5. **Architecture Invariants**: `docs/ARCHITECTURE.md` (Single Authority Model, IPC Security Boundary, Credential DPAPI).
6. **Settled Decisions**: `docs/DECISIONS.md` (rationale for historical technical choices).
7. **Packaging & Release**: `docs/PACKAGING_AND_INSTALLATION_GUIDE.md` (NSIS and Portable build requirements).

Never guess or assume behavior when documented ground truth is available.
