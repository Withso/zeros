"""Immutable, private Computer build records. Not launch authority.

The base verifies this module before import. A reader must supply the evidence
digest from CP; neither a stored file nor a request chooses another pathname.
"""
import contextlib
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import time

if "_verified_integrity" in globals():
    # The fixed installer compiles both helpers from the same bytes whose
    # hashes it checked against the externally pinned base. Never reopen a
    # companion pathname between that check and executing its code.
    integrity = globals().pop("_verified_integrity")
else:
    _spec = importlib.util.spec_from_file_location("zeros_computer_boot_integrity", Path(__file__).with_name("computer-boot-integrity.py"))
    integrity = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(integrity)

MAX_EVIDENCE = 64 * 1024
LIMITS = {"integrity.json": integrity.INTEGRITY_MAX_BYTES, "evidence.json": MAX_EVIDENCE, "report.json": MAX_EVIDENCE}
UUID = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"
HEX = r"[a-f0-9]{64}"
NAME = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
RESULTS = {"runtime", "identity", "resources", "mounts", "credentials", "actorTools", "lsps", "capture",
           "humanServices", "setupProcess", "retirement", "census"}
RUNTIME_FIELDS = {"runtimeId", "manifestSha256", "installerReceiptSha256", "baseCompatibilityId", "bootId", "supervisorSessionId"}
FORBIDDEN_XATTRS = {"security.capability", "system.posix_acl_access", "system.posix_acl_default"}
ROLE_CHECKS = {
    "identity": ["engine-no-new-privileges-and-seccomp", "engine-non-root-empty-capabilities", "fixed-engine-user-namespace",
        "readonly-image-authority", "host-authority-absent", "host-root-authority-denied", "global-kernel-control-writes-denied",
        "host-user-namespace-entry-denied", "readonly-mounts-locked", "inherited-unmount-denied",
        "same-engine-child-shared-files", "finite-engine-and-descendant-resources"],
    "actorTools": ["immutable-engine-registration-attestation", "captured-provider-credential-and-engine-identity", "shared-managed-worktree",
        "legacy-workload-bridge-engine-identity", "agent-native-language-tools", "human-typescript-python-tools",
        "independent-device-tool-lifetime", "disk-document-refresh", "symlink-read-denial",
        "original-detached-group-and-non-escaped-descendants-retired", "timeout-original-group-retired"],
    "humanServices": ["ssh-in-admitted-engine-view", "ssh-engine-identity", "shared-engine-attachment-staging",
        "same-mount-atomic-attachment-publication", "ssh-exec-output-and-exit", "ssh-exec-and-pty", "ssh-sftp", "ssh-original-group-descendants-retired"],
}
RUNTIME_CHECKS = ["node_abi", "sqlite_query", "pty_load", "claude_version", "codex_version", "cursor_load", "engine_load",
                  "supervisor_idle", "engine_lifecycle"]
RESULT_ORDER = ["runtime", "identity", "resources", "mounts", "credentials", "actorTools", "lsps", "capture",
                "humanServices", "setupProcess", "retirement", "census"]


class Failure(Exception):
    def __init__(self, *, timed_out=False):
        super().__init__("computer_build_qualification_unavailable")
        self.timed_out = timed_out


def require(condition):
    if not condition: raise Failure()


def shape(value, keys, optional=()):
    require(type(value) is dict and set(keys) <= value.keys() <= set(keys) | set(optional))


def match(value, expression): require(type(value) is str and re.fullmatch(expression, value))
def integer(value, minimum=1, maximum=9_007_199_254_740_991): require(type(value) is int and minimum <= value <= maximum)
def packed(value): return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
def digest(value): return hashlib.sha256(packed(value)).hexdigest()


def strict_json(raw):
    def pairs(items):
        value = {}
        for name, item in items:
            require(name not in value)
            value[name] = item
        return value
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False))
        require(packed(value) == raw)
        return value
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise Failure() from None


def timestamp(value):
    match(value, r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})")
    try: return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError): raise Failure() from None


def validate_evidence(value):
    """Closed Python reader for the Q1a contract; CP still validates on insert."""
    try:
        shape(value, ("schema", "scope", "builder", "runtime", "base", "kernel", "policy", "results", "reportSha256",
                      "sanitationManifestSha256", "qualifiedAt"))
        require(value["schema"] == "zeros.computer-build-qualification/v1" and len(packed(value)) <= MAX_EVIDENCE)
        scope, builder, runtime, base, kernel, policy = (value[key] for key in ("scope", "builder", "runtime", "base", "kernel", "policy"))
        shape(scope, ("organizationId", "buildId", "configId", "provider", "channel", "accountScope", "billingOrg"))
        for key in ("organizationId", "buildId", "configId"): match(scope[key], UUID)
        require(scope["provider"] == "boat" and scope["channel"] in ("development", "alpha", "beta", "production"))
        match(scope["accountScope"], NAME)
        match(scope["billingOrg"], r"[^\x00-\x1f\x7f]{1,512}")
        shape(builder, ("operationKey", "sandboxId", "helperFence", "workerFence", "bootId"))
        require(builder["operationKey"] == "computer-build:" + scope["buildId"])
        match(builder["sandboxId"], r"bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}")
        match(builder["bootId"], UUID)
        integer(builder["workerFence"])
        integer(builder["helperFence"], maximum=builder["workerFence"])
        shape(runtime, ("runtimeId", "manifestSha256", "archiveSha256", "engineProtocolVersion", "installerReceiptSha256"))
        for key in ("manifestSha256", "archiveSha256", "installerReceiptSha256"): match(runtime[key], HEX)
        integer(runtime["engineProtocolVersion"], maximum=65535)
        require(runtime["runtimeId"] == "r1-" + runtime["manifestSha256"])
        shape(base, ("baseImageId", "baseCompatibilityId", "compatibilitySha256", "sourceCommit", "architecture",
                     "protectedContractSha256", "bootIntegritySha256"))
        match(base["baseImageId"], NAME)
        match(base["sourceCommit"], r"[a-f0-9]{40}")
        for key in ("compatibilitySha256", "protectedContractSha256", "bootIntegritySha256"): match(base[key], HEX)
        require(base["baseCompatibilityId"] == "bc1-" + base["compatibilitySha256"] and base["architecture"] == "linux/amd64")
        shape(kernel, ("release", "version", "architecture", "buildId", "notesSha256", "features"))
        for key in ("release", "version"): match(kernel[key], r"[\x20-\x7e]{1,256}")
        require(kernel["architecture"] == "x86_64")
        match(kernel["buildId"], r"(?:[a-f0-9]{2}){1,128}")
        match(kernel["notesSha256"], HEX)
        shape(kernel["features"], ("cgroupV2", "userNamespaces", "seccompFilter", "apparmor"))
        require(all(item is True for item in kernel["features"].values()))
        shape(policy, ("version", "sha256", "resourcePolicySha256"), ("runnerVersion",))
        integer(policy["version"], maximum=1)
        for key in ("sha256", "resourcePolicySha256"): match(policy[key], HEX)
        runner = "runnerVersion" in policy
        if runner: integer(policy["runnerVersion"], maximum=1)
        shape(value["results"], RESULTS | ({"runner"} if runner else set()))
        require(all(item is True for item in value["results"].values()))
        for key in ("reportSha256", "sanitationManifestSha256"): match(value[key], HEX)
        timestamp(value["qualifiedAt"])
        return value
    except (TypeError, ValueError, KeyError, OverflowError, RecursionError):
        raise Failure() from None


def validate_bundle(build_id, values):
    match(build_id, UUID)
    shape(values, LIMITS)
    for name, value in values.items(): require(0 < len(packed(value)) <= LIMITS[name])
    evidence = validate_evidence(values["evidence.json"])
    require(evidence["scope"]["buildId"] == build_id and
            digest(values["integrity.json"]) == evidence["base"]["bootIntegritySha256"] and
            digest(values["report.json"]) == evidence["reportSha256"])


def identity(info): return info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid


class QualificationStore:
    def __init__(self, root=Path("/"), *, uid=0, gid=0):
        self.root, self.uid, self.gid = Path(root), uid, gid

    def metadata(self, fd, *, directory, private=False):
        info = os.fstat(fd)
        require((info.st_uid, info.st_gid) == (self.uid, self.gid) and
                not FORBIDDEN_XATTRS.intersection(os.listxattr(fd)))
        if directory:
            require(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o7022 and
                    (not private or stat.S_IMODE(info.st_mode) == 0o700))
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o444)
        return info

    @contextlib.contextmanager
    def opened(self, build_id, *, create=False, allow_absent=False):
        match(build_id, UUID)
        try:
            with contextlib.ExitStack() as stack:
                parent = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                stack.callback(os.close, parent)
                root_fd = parent
                original = identity(self.metadata(parent, directory=True))
                watches, created = [], False

                def check():
                    require(identity(self.metadata(root_fd, directory=True)) == original == identity(os.lstat(self.root)))
                    for directory, part, fd, before, private in watches:
                        require(identity(self.metadata(fd, directory=True, private=private)) == before ==
                                identity(os.stat(part, dir_fd=directory, follow_symlinks=False)))

                parts = ["srv", "zeros", "runtime-installs", "build-qualifications", build_id]
                for index, part in enumerate(parts):
                    private = index >= 2
                    if create:
                        check()
                        try:
                            os.mkdir(part, 0o700 if private else 0o755, dir_fd=parent)
                            os.fsync(parent)
                            if index == len(parts) - 1: created = True
                        except FileExistsError: pass
                    try: before = os.stat(part, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        if not allow_absent: raise
                        check()
                        yield None, False, check
                        check()
                        try: os.stat(part, dir_fd=parent, follow_symlinks=False)
                        except FileNotFoundError: return
                        raise Failure()
                    fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                    stack.callback(os.close, fd)
                    require(identity(self.metadata(fd, directory=True, private=private)) == identity(before))
                    watches.append((parent, part, fd, identity(before), private))
                    parent = fd
                check()
                yield parent, created, check
                check()
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            raise Failure() from None

    @contextlib.contextmanager
    def _read(self, directory, check):
        names = sorted(os.listdir(directory))
        require(names == sorted(LIMITS))
        values, watches = {}, []

        def file_identity(info):
            return (*identity(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

        def validate():
            check()
            require(sorted(os.listdir(directory)) == names)
            for name, fd, original in watches:
                current = os.stat(name, dir_fd=directory, follow_symlinks=False)
                require(file_identity(self.metadata(fd, directory=False)) == original == file_identity(current))

        # Keep all three original files open until their external digest and
        # cross-file bindings have been checked. Later I/O cannot make an
        # earlier observation of replaced or rewritten bytes current again.
        with contextlib.ExitStack() as stack:
            for name, limit in LIMITS.items():
                before = os.stat(name, dir_fd=directory, follow_symlinks=False)
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
                stack.callback(os.close, fd)
                opened = self.metadata(fd, directory=False)
                require(file_identity(before) == file_identity(opened) and 0 < opened.st_size <= limit)
                watches.append((name, fd, file_identity(opened)))
                chunks, size = [], 0
                while size <= limit:
                    raw = os.read(fd, min(8192, limit + 1 - size))
                    if not raw: break
                    chunks.append(raw)
                    size += len(raw)
                require(size == opened.st_size and size <= limit)
                validate()
                values[name] = strict_json(b"".join(chunks))
            try:
                yield values
            finally:
                validate()

    @contextlib.contextmanager
    def verified(self, build_id, evidence_sha256):
        match(evidence_sha256, HEX)
        with self.opened(build_id) as (directory, _created, check):
            with self._read(directory, check) as values:
                validate_bundle(build_id, values)
                require(digest(values["evidence.json"]) == evidence_sha256)
                yield values

    def read(self, build_id, evidence_sha256):
        with self.verified(build_id, evidence_sha256) as values:
            return values

    def present(self, build_id):
        with self.opened(build_id, allow_absent=True) as (directory, _created, _check):
            return directory is not None

    def publish(self, build_id, values):
        validate_bundle(build_id, values)
        # Freeze caller data before any filesystem I/O. A partial write is
        # retained and refuses a retry; never repair or replace unknown bytes.
        frozen = {name: strict_json(packed(value)) for name, value in values.items()}
        with self.opened(build_id, create=True) as (directory, created, check):
            if created:
                for name in LIMITS:
                    check()
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                 0o600, dir_fd=directory)
                    try:
                        raw = packed(frozen[name])
                        while raw:
                            count = os.write(fd, raw)
                            require(count > 0)
                            raw = raw[count:]
                        os.fchmod(fd, 0o444)
                        self.metadata(fd, directory=False)
                        os.fsync(fd)
                        check()
                    finally: os.close(fd)
                os.fsync(directory)
            with self._read(directory, check) as current:
                require(packed(current) == packed(frozen))
                validate_bundle(build_id, current)


def validate_report(report, runtime, *, runner, resource_sha256):
    shape(report, ("schema", "runtime", "policy", "results", "checks", "qualifiedAt"))
    require(report["schema"] == "zeros.computer-self-test/v1" and len(packed(report)) <= MAX_EVIDENCE)
    shape(report["runtime"], RUNTIME_FIELDS)
    require(report["runtime"] == runtime and report["checks"] == ROLE_CHECKS)
    policy = {"schema": "zeros.computer-self-test/v1", "runtime": RUNTIME_CHECKS, "roles": ROLE_CHECKS,
              "final": ["setup_process", "final_census", "final_identity"], "results": RESULT_ORDER}
    if runner: policy["runnerVersion"] = 1
    expected = {"version": 1, "sha256": digest(policy), "resourcePolicySha256": resource_sha256}
    if runner: expected["runnerVersion"] = 1
    require(report["policy"] == expected)
    shape(report["results"], RESULTS | ({"runner"} if runner else set()))
    require(all(value is True for value in report["results"].values()))
    timestamp(report["qualifiedAt"])


def integrity_document(evidence, closure, kernel_features):
    # No current boot, PID, inode, worker fence or supervisor session is a
    # cross-boot equality condition. Their fresh witnesses are checked below.
    value = {"schema": "zeros.computer-boot-integrity/v1", "scope": evidence["scope"], "runtime": evidence["runtime"],
             "base": {key: evidence["base"][key] for key in ("baseImageId", "baseCompatibilityId", "compatibilitySha256", "sourceCommit", "architecture")},
             "policy": evidence["policy"], "kernel": evidence["kernel"], "kernelFeatures": kernel_features, "closure": closure}
    require(len(packed(value)) <= LIMITS["integrity.json"])
    return value


def validate_preserved(values, manifest, manifest_sha256):
    evidence, document, report = (values[name] for name in ("evidence.json", "integrity.json", "report.json"))
    validate_bundle(evidence["scope"]["buildId"], values)
    require(digest(manifest) == manifest_sha256 == evidence["sanitationManifestSha256"] and
            manifest["buildId"] == evidence["scope"]["buildId"] and manifest["configId"] == evidence["scope"]["configId"] and
            manifest["runtimeId"] == evidence["runtime"]["runtimeId"] and manifest["baseImageId"] == evidence["base"]["baseImageId"] and
            manifest["baseCompatibilityId"] == evidence["base"]["baseCompatibilityId"] and
            manifest["protectedContractDigest"] == evidence["base"]["protectedContractSha256"])
    require(document == integrity_document(evidence, document["closure"], document["kernelFeatures"]))
    historical_runtime = {**{key: evidence["runtime"][key] for key in ("runtimeId", "manifestSha256", "installerReceiptSha256")},
        "baseCompatibilityId": evidence["base"]["baseCompatibilityId"], "bootId": evidence["builder"]["bootId"],
        "supervisorSessionId": report["runtime"]["supervisorSessionId"]}
    match(historical_runtime["supervisorSessionId"], UUID)
    validate_report(report, historical_runtime, runner=evidence["policy"].get("runnerVersion") == 1,
        resource_sha256=evidence["policy"]["resourcePolicySha256"])
    require(report["qualifiedAt"] == evidence["qualifiedAt"] and report["policy"] == evidence["policy"] and report["results"] == evidence["results"])


def active_witness(app, expected_runtime, receipt):
    value = strict_json(app.read("/run/zeros/active-runtime.json", 4096, 0o600))
    shape(value, RUNTIME_FIELDS | {"schema", "root", "cgroupRoot"})
    require(value["schema"] == "zeros.active-runtime/v1" and value["runtimeId"] == app.current() == expected_runtime["runtimeId"] and
            value["root"] == "/opt/zeros-infra/" + value["runtimeId"] and
            value["cgroupRoot"] == "/sys/fs/cgroup/system.slice/zeros-host.service" and
            value["manifestSha256"] == expected_runtime["manifestSha256"] and value["baseCompatibilityId"] == app.compat_id and
            value["bootId"] == app.boot_id() and value["installerReceiptSha256"] == hashlib.sha256(receipt).hexdigest())
    match(value["bootId"], UUID)
    match(value["supervisorSessionId"], UUID)
    return {key: value[key] for key in RUNTIME_FIELDS}


def full_runtime(app, expected):
    app.base()
    app.require_persistence()
    require(app.current() == expected["runtimeId"])
    manifest, receipt = app.verify_runtime(expected["runtimeId"], full=True)
    require(manifest["protocols"]["engine"] == expected["engineProtocolVersion"] and
            strict_json(receipt)["archiveSha256"] == expected["archiveSha256"])
    return manifest, receipt, active_witness(app, expected, receipt)


def base_build(app, expected):
    require(app.compat_id == expected["baseCompatibilityId"])
    integer(app.compat.get("buildQualificationVersion"), maximum=1)
    value = strict_json(app.read("/etc/zeros/base-build.json", 4096, 0o444))
    shape(value, ("schema", "profile", "sourceCommit", "sourceSha256", "baseCompatibilityId"))
    require(value["schema"] == "zeros.base-build/v1" and value["profile"] == "zeros-cloud-worker-v4" and
            value["sourceCommit"] == expected["sourceCommit"] and value["baseCompatibilityId"] == expected["baseCompatibilityId"])
    match(value["sourceSha256"], HEX)


def produce_build(app, request, *, verify_tcb, command, now=time.time):
    """One full build, under the existing installation/publication boundaries.

    This call never accepts a pre-existing local result as CP acknowledgement.
    A resumed worker must read the immutable CP checkpoint before choosing it.
    Callback injection is for local tests; the fixed caller supplies base-owned
    verification and bounded command functions, never request-selected code.
    """
    try:
        request = strict_json(packed(request))
        shape(request, ("schema", "buildId", "workerFence", "producerFence", "scope", "builder", "runtime", "base",
                        "protectedContractSha256", "sanitationManifestSha256", "deadlineAt"))
        require(request["schema"] == "zeros.computer-build-qualification-input/v1")
        match(request["buildId"], UUID)
        integer(request["workerFence"])
        integer(request["producerFence"], minimum=request["workerFence"])
        shape(request["runtime"], ("runtimeId", "manifestSha256", "archiveSha256", "engineProtocolVersion"))
        shape(request["builder"], ("operationKey", "sandboxId"))
        shape(request["base"], ("baseImageId", "baseCompatibilityId", "compatibilitySha256", "sourceCommit", "architecture"))
        match(request["runtime"]["runtimeId"], "r1-" + HEX)
        require(request["scope"]["buildId"] == request["buildId"])
        deadline, started = timestamp(request["deadlineAt"]), now()
        require(started < deadline)
        monotonic_deadline = time.monotonic() + deadline - started

        def remaining():
            budget = min(deadline - now(), monotonic_deadline - time.monotonic())
            if budget <= 0: raise Failure(timed_out=True)
            return budget

        def bounded(args, **kwargs):
            kwargs["timeout"] = min(kwargs.get("timeout", 60), remaining())
            result = command(args, **kwargs)
            remaining()
            return result

        store = QualificationStore(app.root, uid=app.uid, gid=app.gid)
        with app.lock("runtime-install.lock"), app.lock("runtime-publication.lock"):
            remaining()
            verify_tcb()
            manifest, receipt, runtime = full_runtime(app, request["runtime"])
            base_build(app, request["base"])
            remaining()
            require(not store.present(request["buildId"]))
            offer_path = "lib/zeros/build-qualification-support.json"
            offers = [entry for entry in manifest["files"] if entry["path"] == offer_path]
            if not offers:
                return {"schema": "zeros.computer-build-producer/v1", "mode": "full"}
            require(len(offers) == 1 and offers[0]["type"] == "file" and offers[0]["mode"] == "0444")
            raw = app.read("/opt/zeros-infra/" + runtime["runtimeId"] + "/" + offer_path, 1024, 0o444)
            offer = strict_json(raw.removesuffix(b"\n"))
            shape(offer, ("schema", "version"))
            integer(offer["version"], maximum=1)
            require(hashlib.sha256(raw).hexdigest() == offers[0]["sha256"] and offer["schema"] == "zeros.build-qualification-support/v1")
            runtime_root = "/opt/zeros-infra/" + runtime["runtimeId"]
            resource = [entry for entry in manifest["files"] if entry["path"] == "lib/zeros/cloud-resource-admission.mjs"]
            require(len(resource) == 1 and resource[0]["type"] == "file")
            match(resource[0]["sha256"], HEX)
            stock = strict_json(app.read("/opt/zeros-bootstrap/stock-prerequisites.json", 128 * 1024, 0o444))
            before = integrity.capture_protected_closure(app.compat, stock, dependencies=[], root=app.root,
                uid=app.uid, gid=app.gid, build_id=request["buildId"], check_budget=remaining)
            remaining()
            dependencies = integrity.discover_loader_dependencies(before, runtime["runtimeId"], manifest, bounded,
                root=app.root, uid=app.uid, gid=app.gid, check_budget=remaining)
            integrity.verify_protected_closure(before, root=app.root, uid=app.uid, gid=app.gid, build_id=request["buildId"], check_budget=remaining)
            closure = integrity.capture_protected_closure(app.compat, stock, dependencies=dependencies, root=app.root,
                uid=app.uid, gid=app.gid, build_id=request["buildId"], check_budget=remaining)
            kernel = integrity.running_kernel_identity()
            remaining()
            code, output = bounded([str(app.root / runtime_root.lstrip("/") / "bin/node"),
                str(app.root / runtime_root.lstrip("/") / "lib/zeros/runtime-self-test.mjs"), "--build-qualification"],
                timeout=600, limit=65_536)
            require(code == 0 and type(output) is bytes and len(output) <= 65_536)
            lines = output.removesuffix(b"\n").split(b"\n")
            require(len(lines) == 2)
            report, diagnostic = (strict_json(line) for line in lines)
            require(diagnostic == {"schema": "zeros.diagnostic/v1", "component": "qualification", "stage": "self_test", "ok": True,
                "exitCode": 0, "timedOut": False, "failedChecks": []})
            # This optional facet is selected by the verified base inventory,
            # never by a report that simply omitted its runner result.
            runner = any(entry["path"] == "/usr/lib/zeros-runner/support.json" for entry in app.compat.get("protectedFiles", []))
            validate_report(report, runtime, runner=runner, resource_sha256=resource[0]["sha256"])
            require(started <= timestamp(report["qualifiedAt"]) <= now() < deadline)

            def recheck():
                remaining()
                verify_tcb()
                current_manifest, current_receipt, current = full_runtime(app, request["runtime"])
                require(current_manifest == manifest and current_receipt == receipt and current == runtime)
                base_build(app, request["base"])
                integrity.verify_protected_closure(closure, root=app.root, uid=app.uid, gid=app.gid, build_id=request["buildId"], check_budget=remaining)
                require(integrity.running_kernel_identity() == kernel and
                        app.read("/srv/zeros/runtime-installs/" + runtime["runtimeId"] + ".json", 4096, 0o600) == receipt and
                        active_witness(app, request["runtime"], receipt) == runtime and now() < deadline)
                remaining()

            recheck()
            evidence = {"schema": "zeros.computer-build-qualification/v1", "scope": request["scope"],
                "builder": {**request["builder"], "helperFence": request["workerFence"], "workerFence": request["producerFence"], "bootId": runtime["bootId"]},
                "runtime": {**request["runtime"], "installerReceiptSha256": runtime["installerReceiptSha256"]},
                "base": {**request["base"], "protectedContractSha256": request["protectedContractSha256"], "bootIntegritySha256": "0" * 64},
                "kernel": kernel["kernel"], "policy": report["policy"], "results": report["results"], "reportSha256": digest(report),
                "sanitationManifestSha256": request["sanitationManifestSha256"], "qualifiedAt": report["qualifiedAt"]}
            validate_evidence(evidence)
            document = integrity_document(evidence, closure, kernel["features"])
            evidence["base"]["bootIntegritySha256"] = digest(document)
            store.publish(request["buildId"], {"integrity.json": document, "evidence.json": evidence, "report.json": report})
            with store.verified(request["buildId"], digest(evidence)) as published:
                require(published["evidence.json"] == evidence)
                recheck()
            remaining()
            return {"schema": "zeros.computer-build-producer/v1", "mode": "build", "evidence": evidence}
    except (OSError, ValueError, TypeError, KeyError, OverflowError, integrity.Failure):
        raise Failure() from None


def validate_selection(selection):
    """Closed Q1a input, copied before any filesystem or kernel observation."""
    try:
        selection = strict_json(packed(selection))
        require(len(packed(selection)) <= MAX_EVIDENCE)
        if selection == {"mode": "full"}: return selection
        shape(selection, ("mode", "qualificationId", "evidenceSha256", "evidence", "snapshot"))
        require(selection["mode"] == "build")
        match(selection["qualificationId"], UUID)
        evidence = validate_evidence(selection["evidence"])
        match(selection["evidenceSha256"], HEX)
        require(digest(evidence) == selection["evidenceSha256"])
        shape(selection["snapshot"], ("name", "snapshotId", "treeSha256"))
        name = selection["snapshot"]["name"]
        match(name, r"[a-z0-9][a-z0-9-]*-" + evidence["scope"]["channel"] + r"-computer-v[1-9][0-9]{0,18}")
        require(len(name) <= 63)
        match(selection["snapshot"]["snapshotId"], r"[A-Za-z0-9_-]{1,160}")
        match(selection["snapshot"]["treeSha256"], HEX)
        return selection
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise Failure() from None


class BuildVerifierSession:
    """Installer-owned verifier; a child cannot select a helper or a new budget.

    The caller already holds the original installation lock and supplies its
    identity check. Only publication.lock is acquired here, in the same order
    as the ordinary installer. This session is not a runtime launch proof.
    """
    def __init__(self, app, selection, descriptor, *, assert_current, monotonic=time.monotonic, now=time.time):
        selected = validate_selection(selection)
        require(selected["mode"] == "build" and callable(assert_current))
        expected = selected["evidence"]["runtime"]
        keys = ("runtimeId", "manifestSha256", "archiveSha256", "engineProtocolVersion")
        require(type(descriptor) is dict and all(descriptor.get(key) == expected[key] for key in keys))
        self.app, self.assert_current = app, assert_current
        self.monotonic, self.now = monotonic, now
        self._selection, self._expected = packed(selected), {key: expected[key] for key in keys}
        self._runtime, self._state, self._exchanges = None, "new", 0
        self._deadline, self._wall_deadline = None, None

    @property
    def selection(self):
        return strict_json(self._selection)

    def _current(self):
        require(self._state == "active")
        self._budget()
        self.assert_current()

    def _budget(self):
        if not (self.monotonic() < self._deadline and self.now() < self._wall_deadline):
            raise Failure(timed_out=True)

    def _verify(self, runtime=None):
        self._current()
        with self.app.lock("runtime-publication.lock"):
            self._current()
            manifest, _receipt, current = full_runtime(self.app, self._expected)
            selected = self.selection
            base_build(self.app, selected["evidence"]["base"])
            if runtime is not None: require(current == runtime)
            offer_path = "lib/zeros/build-boot-support.json"
            offers = [entry for entry in manifest["files"] if entry["path"] == offer_path]
            require(len(offers) == 1 and offers[0]["type"] == "file" and offers[0]["mode"] == "0444")
            raw = self.app.read("/opt/zeros-infra/" + current["runtimeId"] + "/" + offer_path, 1024, 0o444)
            offer = strict_json(raw.removesuffix(b"\n"))
            shape(offer, ("schema", "version"))
            integer(offer["version"], maximum=1)
            require(hashlib.sha256(raw).hexdigest() == offers[0]["sha256"] and
                    offer["schema"] == "zeros.build-boot-support/v1")
            result = verify_selected_build(self.app, selected, current, check_budget=self._budget)
            self._current()
        self._current()
        return result

    def start(self, deadline, wall_deadline):
        try:
            require(self._state == "new" and all(type(value) in (int, float) and math.isfinite(value)
                    for value in (deadline, wall_deadline)))
            self._deadline, self._wall_deadline, self._state = deadline, wall_deadline, "active"
            result = self._verify()
            self._runtime = strict_json(packed(result["runtime"]))
            self._current()
            return {"schema": "zeros.computer-build-verifier-session/v1", "selection": self.selection,
                    "deadlineMs": int(wall_deadline * 1000)}
        except BaseException:
            self._state = "failed"
            raise

    def verify(self, request):
        try:
            self._current()
            request = strict_json(packed(request))
            shape(request, ("selection", "runtime"))
            require(packed(request["selection"]) == self._selection and request["runtime"] == self._runtime and
                    self._exchanges < 8)
            result = self._verify(self._runtime)
            self._current()
            self._exchanges += 1
            return result
        except BaseException:
            self._state = "failed"
            raise

    def finish(self):
        try:
            self._current()
            require(self._exchanges > 0)
            self._verify(self._runtime)
            self._current()
            self._state = "finished"
        except BaseException:
            self._state = "failed"
            raise


def verify_selected_build(app, selection, runtime, *, check_budget=None):
    """Base verification for Q1c's required callback, not admission by itself.

    The fixed installer session calls this within its original install/publication
    ownership; reacquiring install.lock from an installer child would deadlock.
    The runtime separately holds setup/engine ownership and current-attempt
    fences, invokes this before/after its actual-view probe, and consumes only
    its fresh single-use launch proof. Runtime selection remains dormant.
    """
    try:
        selection = validate_selection(selection)
        require(selection["mode"] == "build")
        evidence = selection["evidence"]
        shape(runtime, RUNTIME_FIELDS)
        original = strict_json(packed(runtime))
        manifest, receipt, before = full_runtime(app, evidence["runtime"])
        base_build(app, evidence["base"])
        require(before == original and before["installerReceiptSha256"] == evidence["runtime"]["installerReceiptSha256"])
        store = QualificationStore(app.root, uid=app.uid, gid=app.gid)
        with store.verified(evidence["scope"]["buildId"], selection["evidenceSha256"]) as values:
            require(values["evidence.json"] == evidence)
            template_raw = app.read("/srv/zeros/computer-template.json", 262_144, 0o444)
            template = strict_json(template_raw)
            validate_preserved(values, template, evidence["sanitationManifestSha256"])
            document = values["integrity.json"]
            measured = {"kernel": evidence["kernel"], "features": document["kernelFeatures"]}
            require(integrity.running_kernel_identity() == measured)
            integrity.verify_protected_closure(document["closure"], root=app.root, uid=app.uid, gid=app.gid, check_budget=check_budget)
            current_manifest, current_receipt, after = full_runtime(app, evidence["runtime"])
            base_build(app, evidence["base"])
            require(current_manifest == manifest and current_receipt == receipt and after == original and
                    integrity.running_kernel_identity() == measured and
                    app.read("/srv/zeros/runtime-installs/" + original["runtimeId"] + ".json", 4096, 0o600) == receipt and
                    active_witness(app, evidence["runtime"], receipt) == original and
                    app.read("/srv/zeros/computer-template.json", 262_144, 0o444) == template_raw)
            integrity.verify_protected_closure(document["closure"], root=app.root, uid=app.uid, gid=app.gid, check_budget=check_budget)
            require(integrity.running_kernel_identity() == measured)
            if check_budget is not None: check_budget()
        return {"schema": "zeros.computer-build-verification/v1", "qualificationId": selection["qualificationId"],
            "evidenceSha256": selection["evidenceSha256"], "bootIntegritySha256": evidence["base"]["bootIntegritySha256"],
            "kernelSha256": digest(evidence["kernel"]), "runtime": original}
    except (OSError, ValueError, TypeError, KeyError, OverflowError, integrity.Failure):
        raise Failure() from None
