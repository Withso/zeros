#!/usr/bin/python3
"""Fixed, deployment-owned v4 update adapter. Invoke with Python -I.

Authentication is the control plane's expiring, command-restricted pinned SSH
channel. The pipe protocol never accepts code, paths or shell commands. Registry
qualification and the quiet/transfer fence belong to the control plane; the VM
independently verifies the source witness and the complete installed trees.
No protected base bytes are changed. Import injection is for rootless tests only.
"""
import contextlib
import fcntl
import importlib.util
import json
import os
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time

JOURNAL = "/srv/zeros/runtime-installs/update.json"
SOCKET = "/run/zeros/cloud-worker-supervisor.sock"
AUDIENCE = "zeros-cloud-worker-supervisor-v1"
SCHEMA = "zeros.runtime-update/v1"
MAX_FRAME = 128 * 1024
ACTIVATION_SECONDS = 240
ROLLBACK_SECONDS = 240
ACTIVE_KEYS = ("schema", "runtimeId", "manifestSha256", "root", "baseCompatibilityId",
               "installerReceiptSha256", "bootId", "supervisorSessionId", "cgroupRoot")
HANDOFF_KEYS = ("challenge", "organizationId", "workspaceId", "generation", "engineInstanceId", "hostId", "fence", "expiresAtMs")
RESIDENT_KEYS = ("hostId", "organizationId", "workspaceId", "protocol", "runtimeId", "manifestSha256",
                 "bootId", "supervisorSessionId", "scope", "fence", "engineId", "generation")


class UpdateFailure(Exception):
    def __init__(self):
        super().__init__("runtime update failed")


class Staged(Exception):
    pass


class Deferred(Exception):
    pass


class ConsumptionUncertain(UpdateFailure):
    pass


def require(value):
    if not value:
        raise UpdateFailure()


def active_document(b, value):
    b.shape(value, ACTIVE_KEYS)
    require(value["schema"] == "zeros.active-runtime/v1")
    b.text_match(value["runtimeId"], b.RID, "input_schema")
    require(value["manifestSha256"] == value["runtimeId"][3:])
    require(value["root"] == b.INFRA + "/" + value["runtimeId"])
    b.text_match(value["baseCompatibilityId"], r"bc1-[a-f0-9]{64}", "input_schema")
    b.text_match(value["installerReceiptSha256"], b.HEX, "input_schema")
    for key in ("bootId", "supervisorSessionId"):
        b.text_match(value[key], b.UUID, "input_schema")
    require(value["cgroupRoot"] == b.CGROUP)
    return value


def validate_scope(b, value):
    b.shape(value, ("workspaceId", "organizationId", "sourceGeneration", "candidateGeneration", "sourceEngineInstanceId"))
    for key in ("workspaceId", "organizationId", "sourceEngineInstanceId"):
        b.text_match(value[key], b.UUID, "input_schema")
    for key in ("sourceGeneration", "candidateGeneration"):
        b.integer(value[key], 1, 2**31 - 1, "input_schema")
    require(value["candidateGeneration"] > value["sourceGeneration"])


def validate_handoff(b, value, request, now):
    b.shape(value, HANDOFF_KEYS)
    for key in ("challenge", "organizationId", "workspaceId", "engineInstanceId", "hostId"):
        b.text_match(value[key], b.UUID, "input_schema")
    for key in ("generation", "fence", "expiresAtMs"):
        b.integer(value[key], 1, 2**53 - 1, "input_schema")
    scope = request["scope"]
    require(all(value[key] == scope[key] for key in ("organizationId", "workspaceId")))
    require(value["generation"] == scope["sourceGeneration"] and value["engineInstanceId"] == scope["sourceEngineInstanceId"])
    require(now.timestamp() * 1000 < value["expiresAtMs"] <= b.timestamp(request["expiresAt"], "input_schema").timestamp() * 1000)


def resident_document(b, value):
    b.shape(value, RESIDENT_KEYS)
    for key in ("hostId", "organizationId", "workspaceId", "bootId", "supervisorSessionId"):
        b.text_match(value[key], b.UUID, "input_schema")
    b.text_match(value["runtimeId"], b.RID, "input_schema")
    require(value["manifestSha256"] == value["runtimeId"][3:] and value["protocol"] == "zeros.resident-pty/v1")
    require(value["scope"] == b.CGROUP + "/engine-workload-" + value["hostId"])
    b.integer(value["fence"], 1, 2**53 - 2, "input_schema")
    if value["engineId"] is None:
        require(value["generation"] is None)
    else:
        b.text_match(value["engineId"], b.UUID, "input_schema")
        b.integer(value["generation"], 1, 2**31 - 1, "input_schema")
    return value


def same_resident(left, right):
    return all(left[key] == right[key] for key in RESIDENT_KEYS if key not in ("engineId", "generation", "fence"))


def validate_enrollment_environment(b, environment, request, rollback, prior_engine_instances=()):
    encoded = environment.get("runtimeB64")
    b.text_match(encoded, r"[A-Za-z0-9_-]{2,98304}", "input_schema")
    require(len(encoded) % 4 != 1)
    raw = b.base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
    require(len(raw) <= 64 * 1024 and b.base64.urlsafe_b64encode(raw).rstrip(b"=").decode() == encoded)
    runtime = b.strict_json(raw, "input_schema")
    require(runtime.get("version") == 1 and runtime.get("audience") == "zeros-cloud-engine-runtime-v1")
    scope, execution, engine = request["scope"], runtime.get("execution", {}), runtime.get("engine", {})
    require(all(execution.get(key) == scope[key] for key in ("workspaceId", "organizationId")))
    require(execution.get("generation") == scope["sourceGeneration" if rollback else "candidateGeneration"])
    b.text_match(engine.get("instanceId"), b.UUID, "input_schema")
    require(engine["instanceId"] != scope["sourceEngineInstanceId"])
    require(engine["instanceId"] not in prior_engine_instances)
    # The supervisor subsequently applies the complete legacy start schema,
    # including strict environment allowlisting and grant/endpoint validation.
    return engine["instanceId"]


def populated(directory):
    with (directory / "cgroup.events").open() as stream:
        data = stream.read(4097)
    require(len(data) <= 4096)
    values = [line for line in data.splitlines() if line.startswith("populated ")]
    require(len(values) == 1 and values[0] in ("populated 0", "populated 1"))
    return values[0] == "populated 1"


class RuntimeInstaller:
    def __init__(self, bootstrap, app, runtime, arm_deadline=lambda _seconds: None):
        self.b, self.app, self.runtime = bootstrap, app, runtime
        self.arm_deadline = arm_deadline

    def active(self):
        return active_document(self.b, self.b.strict_json(self.app.read(self.b.ACTIVE, 4096, 0o600), "input_schema"))

    def check_source(self, request):
        self.app.require_persistence()
        require(self.active() == request["source"])
        require(self.app.current() == request["source"]["runtimeId"])
        require(self.app.compat_id == request["source"]["baseCompatibilityId"])
        require(self.app.boot_id() == request["source"]["bootId"])
        require(not os.path.lexists(self.app.path(self.b.RECEIPTS + "/switch-intent.json")))
        for name in ("current", "previous"):
            runtime_id = self.app.current(name)
            if runtime_id:
                require(not os.path.lexists(self.app.path(self.app.incomplete_marker(runtime_id))))
        self.check_expiry(request)

    def check_expiry(self, request):
        remaining = (self.b.timestamp(request["expiresAt"], "input_schema") - self.app.now()).total_seconds()
        require(0 < remaining <= 900)

    def journal(self, request, phase):
        # Only immutable identities and closed states. Never persist grants,
        # artifact URLs, environments, stdout, or a free-form exception.
        value = {key: request[key] for key in ("transitionId", "fence", "scope", "source", "mode")}
        value.update(schema=SCHEMA, phase=phase, target=request["target"])
        if "handoff" in request:
            value["handoff"] = request["handoff"]
            value["resident"] = self.runtime.resident
        self.app.atomic(JOURNAL, self.b.packed(value))

    def check_journal(self):
        try:
            value = self.b.strict_json(self.app.read(JOURNAL, 16384, 0o600), "input_schema")
        except FileNotFoundError:
            return
        require(value.get("schema") == SCHEMA and value.get("phase") in ("healthy", "rolled_back", "cancelled"))

    @contextlib.contextmanager
    def setup_lock(self):
        # Existing v4 setup uses util-linux flock, which may create this empty
        # root-owned file with mode 0644. Reuse its inode/lock without changing
        # permissions; Bootstrap.lock's new 0600-only locks are not this ABI.
        with self.app.directory("/run/zeros") as directory:
            fd = os.open("setup.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                         0o600, dir_fd=directory)
            try:
                st = os.fstat(fd)
                require(stat.S_ISREG(st.st_mode) and st.st_uid == self.app.uid and st.st_gid == self.app.gid and
                        st.st_nlink == 1 and st.st_size == 0 and stat.S_IMODE(st.st_mode) in (0o600, 0o640, 0o644))
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                yield
            finally:
                os.close(fd)

    def response(self, request, outcome, active=None):
        result = {"schema": SCHEMA, "operation": request["operation"], "transitionId": request["transitionId"],
                  "fence": request["fence"], "scope": request["scope"], "outcome": outcome}
        if active is not None:
            result["active"] = active
        return result

    def run(self, request):
        b, app = self.b, self.app
        b.shape(request, ("schema", "operation", "transitionId", "fence", "scope", "expiresAt", "source", "mode"),
                ("install", "target", "handoff"))
        require(request["schema"] == SCHEMA and request["operation"] in ("stage", "activate"))
        require(request["mode"] in ("bootstrap", "engine"))
        for key in ("transitionId", "fence"):
            b.text_match(request[key], b.UUID, "input_schema")
        validate_scope(b, request["scope"])
        active_document(b, request["source"])
        app.base()
        self.check_expiry(request)
        if "handoff" in request:
            require(request["operation"] == "activate" and request["mode"] == "engine")
            validate_handoff(b, request["handoff"], request, app.now())
        with self.setup_lock(), app.lock("runtime-update.lock"):
            self.check_journal()
            if request["operation"] == "stage":
                require("target" not in request and type(request.get("install")) is str)
                return self.stage(request)
            require("install" not in request and "target" in request)
            b.validate_descriptor(request["target"])
            require(request["target"]["runtimeId"] != request["source"]["runtimeId"])
            with app.lock("runtime-install.lock"):
                self.check_source(request)
                _, receipt = app.verify_runtime(request["source"]["runtimeId"], full=True)
                require(b.sha(receipt) == request["source"]["installerReceiptSha256"])
                app.verify_runtime(request["target"]["runtimeId"], full=True, descriptor=request["target"])
                return self.activate(request)

    def stage(self, request):
        owner, b, app = self, self.b, self.app
        value = b.validate_input(request["install"].encode("ascii"), app.compat, app.now())
        require(value["purpose"] in ("build", "qualification") and "setup" not in value)
        require(value["runtime"]["runtimeId"] != request["source"]["runtimeId"])

        class NoHostChanges:
            def stop(self):
                raise UpdateFailure()

            def start(self, *_):
                raise UpdateFailure()

        class StageOnly(b.Bootstrap):
            @contextlib.contextmanager
            def lock(self, name):
                with super().lock(name):
                    if name == "runtime-install.lock":
                        owner.check_source(request)
                    yield

            def switch(self, runtime_id):
                # The original installer did ALL archive/manifest/extraction/
                # receipt checks before reaching this hook. Also hash cache
                # contents, including freshly installed contents, here.
                self.verify_runtime(runtime_id, full=True, descriptor=value["runtime"])
                owner.check_source(request)
                raise Staged()

        staged = StageOnly.__new__(StageOnly)
        staged.__dict__.update(app.__dict__)
        staged.host = NoHostChanges()
        try:
            staged.install(request["install"].encode("ascii"))
        except Staged:
            return self.response(request, "staged")
        raise UpdateFailure()

    def activate(self, request):
        app, original_host, owner = self.app, self.app.host, self
        started = False
        deadline = None

        class GuardedHost:
            def stop(self):
                nonlocal started, deadline
                owner.check_source(request)
                if not owner.runtime.authorize(request):
                    raise Deferred()
                # The CP's compare-and-set has now closed admission. A stale
                # source or expired permit must still fail before retirement.
                owner.check_source(request)
                deadline = time.monotonic() + ACTIVATION_SECONDS
                owner.journal(request, "consumption_authorized" if "handoff" in request else "activating")
                started = True
                owner.arm_deadline(ACTIVATION_SECONDS)
                if request["mode"] == "bootstrap":
                    original_host.stop()
                else:
                    owner.runtime.retire()
                    if "handoff" in request:
                        owner.journal(request, "source_retired")

        try:
            app.host = GuardedHost()
            app.switch(request["target"]["runtimeId"])
            app.host = original_host
            if request["mode"] == "bootstrap":
                original_host.start(app, request["target"]["runtimeId"])
            else:
                with app.lock("runtime-publication.lock"):
                    app.activate(request["target"]["runtimeId"], self.b.CGROUP)
            active = self.active()
            self.journal(request, "selected")
            self.runtime.selected(active)
            require(self.runtime.launch_and_health(active, False, deadline))
            require(time.monotonic() < deadline)
            self.journal(request, "healthy")
            return self.response(request, "healthy", active)
        except Deferred:
            if "handoff" in request:
                self.journal(request, "cancelled")
            return self.response(request, "deferred")
        except ConsumptionUncertain:
            self.journal(request, "recovery_required")
            return self.response(request, "recovery_required")
        except Exception:
            if not started:
                raise
        finally:
            app.host = original_host
        return self.rollback(request)

    def rollback(self, request):
        app, host = self.app, self.app.host
        deadline = time.monotonic() + ROLLBACK_SECONDS
        self.arm_deadline(ROLLBACK_SECONDS)
        try:
            # A lost health response is not permission to reverse CP authority.
            # Reconciliation must fence the candidate before restoring source.
            require(self.runtime.authorize_rollback(request))
            self.journal(request, "rolling_back")
            _, receipt = app.verify_runtime(request["source"]["runtimeId"], full=True)
            require(self.b.sha(receipt) == request["source"]["installerReceiptSha256"])
            if request["mode"] == "engine":
                runtime = self.runtime

                class EngineHost:
                    def stop(self):
                        runtime.retire()

                app.host = EngineHost()
            app.switch(request["source"]["runtimeId"])
            app.host = host
            if request["mode"] == "bootstrap":
                host.start(app, request["source"]["runtimeId"])
            else:
                with app.lock("runtime-publication.lock"):
                    app.activate(request["source"]["runtimeId"], self.b.CGROUP)
            active = self.active()
            self.runtime.selected(active)
            require(self.runtime.launch_and_health(active, True, deadline))
            require(time.monotonic() < deadline)
            self.journal(request, "rolled_back")
            return self.response(request, "rolled_back", active)
        except Exception:
            # No source grant is reused; uncertain authority stays closed.
            self.journal(request, "recovery_required")
            return self.response(request, "recovery_required")
        finally:
            app.host = host


class Pipe:
    """One bounded request/response at a time over the pinned root SSH pipe."""
    def __init__(self, b):
        self.b = b

    def read(self, timeout):
        deadline = time.monotonic() + timeout
        value = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(sys.stdin, selectors.EVENT_READ)
            while len(value) <= MAX_FRAME:
                require(time.monotonic() < deadline)
                if not selector.select(max(0, deadline - time.monotonic())):
                    raise UpdateFailure()
                byte = os.read(sys.stdin.fileno(), 1)
                require(byte)
                if byte == b"\n":
                    return self.b.strict_json(bytes(value), "input_schema")
                value.extend(byte)
        raise UpdateFailure()

    def write(self, value):
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def exchange(self, request, phase, active=None, report=None, controller=None, timeout=15, resident=None, handoff=None):
        value = {"schema": SCHEMA, "phase": phase, "transitionId": request["transitionId"],
                 "fence": request["fence"], "scope": request["scope"]}
        if active is not None:
            value["active"] = active
        if report is not None:
            value["report"] = report
        if controller is not None:
            value["controller"] = controller
        if resident is not None:
            value["resident"] = resident
        if handoff is not None:
            value["handoff"] = handoff
        self.write(value)
        reply = self.read(timeout)
        self.b.shape(reply, ("schema", "phase", "transitionId", "fence", "scope", "allow"), ("environment",))
        require(all(reply[key] == value[key] for key in ("schema", "phase", "transitionId", "fence", "scope")))
        require(type(reply["allow"]) is bool)
        return reply


class SystemRuntime:
    def __init__(self, b, app, pipe, request):
        self.b, self.app, self.pipe, self.request = b, app, pipe, request
        self.session = None
        self.controller = None
        self.resident = None
        self.source_retired = False
        self.resident_enrollment = None
        self.resident_prepare_fields = None
        self.enrolled_engine_instances = set()

    def authorize(self, request):
        if "handoff" in request:
            validate_handoff(self.b, request["handoff"], request, self.app.now())
            status = self.supervisor("resident-status")
            require(status.get("outcome") == "ready")
            self.resident = resident_document(self.b, status.get("resident"))
            handoff = request["handoff"]
            require(all(self.resident[key] == handoff[key] for key in ("hostId", "organizationId", "workspaceId", "generation", "fence")))
            require(self.resident["engineId"] == handoff["engineInstanceId"] and self.resident["bootId"] == request["source"]["bootId"])
            # Resident bytes may belong to an earlier engine selection. Verify
            # their own complete tree; the new engine manifest is not evidence.
            self.app.verify_runtime(self.resident["runtimeId"], full=True)
        self.check_source_scope()
        status = self.supervisor("update-status")
        if request["mode"] == "bootstrap":
            # Only a pre-update supervisor may use the one-time host restart.
            require(status.get("outcome") == "rejected")
        else:
            require(status.get("outcome") == "ready" and status.get("selected") == request["source"])
            self.controller = active_document(self.b, status.get("controller"))
            require(all(self.controller[key] == request["source"][key] for key in
                        ("baseCompatibilityId", "bootId", "cgroupRoot")))
            _, receipt = self.app.verify_runtime(self.controller["runtimeId"], full=True)
            require(self.b.sha(receipt) == self.controller["installerReceiptSha256"])
        if "handoff" in request:
            handoff = request["handoff"]
            result = self.supervisor("runtime-handoff", action="prepare", handoff=handoff)
            if result.get("outcome") == "draining":
                require(self.supervisor("runtime-handoff", action="cancel", handoff=handoff).get("outcome") == "cancelled")
                return False
            require(result.get("outcome") == "fenced")
            receipt = result.get("handoff")
            self.b.shape(receipt, (*HANDOFF_KEYS, "version", "phase", "activityRevision"))
            require(all(receipt[key] == handoff[key] for key in HANDOFF_KEYS) and receipt["version"] == 1 and receipt["phase"] == "fenced")
            self.b.integer(receipt["activityRevision"], 0, 2**53 - 1, "input_schema")
            self.check_source_scope()
            allowed = self.pipe.exchange(request, "authorize_consumption", controller=self.controller,
                                         resident=self.resident, handoff=receipt)["allow"]
            if not allowed:
                require(self.supervisor("runtime-handoff", action="cancel", handoff=handoff).get("outcome") == "cancelled")
        else:
            allowed = self.pipe.exchange(request, "authorize", controller=self.controller)["allow"]
        if allowed:
            self.check_source_scope()
        return allowed

    def check_source_scope(self):
        self.check_scope(retired=False)

    def check_retired_scope(self):
        self.check_scope(retired=True)

    def check_scope(self, retired):
        root = self.app.path(self.b.CGROUP)
        allowed = "engine-" + self.request["scope"]["sourceEngineInstanceId"]
        # The resident uses the base-compatible engine-* namespace. Only its
        # exact verified leaf may stay populated when ordinary engines retire.
        retained = "engine-workload-" + self.resident["hostId"] if self.resident else None
        with self.app.directory(self.b.CGROUP):
            require(not (root / "cgroup.procs").read_text().strip())
            leaves = [entry for entry in root.iterdir() if entry.is_dir()]
            require(len(leaves) <= 1024 and any(entry.name == "host" for entry in leaves))
            for entry in leaves:
                with self.app.directory(self.b.CGROUP + "/" + entry.name):
                    require(entry.name in ("host", "setup", retained) or self.b.re.fullmatch(r"engine-[A-Za-z0-9_-]{1,128}", entry.name))
                    require(not any(child.is_dir() for child in entry.iterdir()))
                    if entry.name not in ("host", retained) and (retired or entry.name != allowed):
                        require(not populated(entry))

    def authorize_rollback(self, request):
        return self.pipe.exchange(request, "authorize_rollback")["allow"]

    def supervisor(self, operation, **fields):
        # Root-only path, no symlink parents, no arbitrary socket selector.
        with self.app.directory("/run/zeros") as directory:
            st = os.stat("cloud-worker-supervisor.sock", dir_fd=directory, follow_symlinks=False)
            require(stat.S_ISSOCK(st.st_mode) and st.st_uid == 0 and st.st_gid == 0 and not st.st_mode & 0o077)
        request = {"version": 1, "audience": AUDIENCE, "operation": operation, **fields}
        raw = self.b.packed(request) + b"\n"
        require(len(raw) <= MAX_FRAME)
        with socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(100 if operation == "select-runtime" else 30)
            peer.connect(SOCKET)
            peer.sendall(raw)
            data = bytearray()
            while len(data) <= MAX_FRAME:
                chunk = peer.recv(4096)
                require(chunk)
                data.extend(chunk)
                if data.endswith(b"\n"):
                    result = self.b.strict_json(bytes(data), "input_schema")
                    require(result.get("version") == 1 and result.get("audience") == AUDIENCE)
                    return result
        raise UpdateFailure()

    def retire(self):
        if self.resident:
            return self.retire_resident()
        reply = self.supervisor("prepare")
        require(reply.get("outcome") == "prepared")
        self.b.text_match(reply.get("session"), r"zsp_[A-Za-z0-9_-]{43}", "input_schema")
        self.session = reply["session"]
        # The supervisor must retire all delegated engine/setup leaves, not
        # merely its tracked child. Independently confirm retirement.
        self.check_retired_scope()

    def retire_resident(self):
        original = self.resident
        if self.resident_enrollment is not None:
            # Rollback was authorized separately by the server. Only the exact
            # freshly enrolled target can be detached; never guess a fence.
            status = self.supervisor("resident-status")
            require(status.get("outcome") == "ready")
            original = resident_document(self.b, status.get("resident"))
            require(same_resident(original, self.resident) and all(original[key] == value for key, value in self.resident_enrollment.items()))
            fields = {"resident": {"hostId": original["hostId"], "engineId": original["engineId"], "fence": original["fence"]}}
        else:
            handoff = self.request["handoff"]
            fields = {"resident": {"hostId": handoff["hostId"], "engineId": handoff["engineInstanceId"], "fence": handoff["fence"]}, "handoff": handoff}
        try:
            # Only an exact retry can replay the root supervisor's unspent
            # session. A lost response never authorizes ordinary prepare.
            for attempt in range(2):
                try:
                    reply = self.supervisor("prepare", **fields)
                    break
                except (ConnectionError, TimeoutError):
                    if attempt:
                        raise
            if reply.get("outcome") == "rejected" and not self.source_retired:
                require(self.supervisor("runtime-handoff", action="cancel", handoff=self.request["handoff"]).get("outcome") == "cancelled")
                status = self.supervisor("resident-status")
                require(status.get("outcome") == "ready")
                attached = resident_document(self.b, status.get("resident"))
                require(attached == original)
                require(self.pipe.exchange(self.request, "cancel_consumption", resident=attached)["allow"])
                raise Deferred()
            require(reply.get("outcome") == "prepared")
            detached = resident_document(self.b, reply.get("resident"))
            # The first receipt can be replayed after selection but before any
            # start consumes the session; it repeats the same detached fence.
            expected_fence = original["fence"] + (1 if original["engineId"] is not None else 0)
            require(same_resident(original, detached) and detached["engineId"] is None and detached["fence"] == expected_fence)
            self.b.text_match(reply.get("session"), r"zsp_[A-Za-z0-9_-]{43}", "input_schema")
            self.session, self.resident, self.resident_enrollment = reply["session"], detached, None
            self.resident_prepare_fields = fields
            self.check_retired_scope()
            if not self.source_retired:
                require(self.pipe.exchange(self.request, "consumed", resident=detached)["allow"])
                self.source_retired = True
        except Deferred:
            raise
        except Exception:
            raise ConsumptionUncertain() from None

    def selected(self, active):
        if self.request["mode"] == "bootstrap":
            # The newly booted supervisor owns its pinned target already.
            self.wait_for_supervisor(active)
            self.retire()
        else:
            reply = self.supervisor("select-runtime", session=self.session, active=active)
            require(reply.get("outcome") == "selected")
        status = self.supervisor("update-status")
        if self.request["mode"] == "bootstrap":
            # Rollback may select an older, legacy supervisor. Its controller
            # is the freshly dispatched source; it has never selected T.
            self.controller = active
            if active["runtimeId"] == self.request["source"]["runtimeId"] and status.get("outcome") == "rejected":
                return
        # The successful bootstrap MUST install an update-capable supervisor.
        # A concurrent host restart cannot be reported as the original resident
        # controller, even when its current engine descriptor happens to match.
        require(status.get("outcome") == "ready" and status.get("selected") == active and
                status.get("controller") == self.controller)

    def wait_for_supervisor(self, active):
        # Base dispatch publishes ACTIVE before execing Node. An active systemd
        # service therefore does not yet prove that its socket is listening.
        # Retry only startup I/O failures, without issuing any mutation. The
        # activation/rollback watchdog also bounds this wait.
        deadline = time.monotonic() + 30
        while True:
            require(self.b.strict_json(self.app.read(self.b.ACTIVE, 4096, 0o600), "input_schema") == active and
                    self.app.current() == active["runtimeId"])
            try:
                require(self.supervisor("status").get("outcome") == "ready")
                return
            except (FileNotFoundError, ConnectionError, TimeoutError):
                require(time.monotonic() < deadline)
                time.sleep(0.1)

    def launch_and_health(self, active, rollback, deadline):
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        root = active["root"]
        child = subprocess.Popen([root + "/bin/node", root + "/lib/zeros/attest-cloud-worker.mjs"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 env=self.b.ENV, start_new_session=True)
        try:
            output = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0)
                    for key, _ in selector.select(remaining):
                        chunk = os.read(key.fileobj.fileno(), 4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            output.extend(chunk)
                            require(len(output) <= MAX_FRAME)
            require(child.wait(timeout=max(0, deadline - time.monotonic())) == 0)
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            raise
        finally:
            child.stdout.close()
        lines = output.splitlines()
        require(len(lines) == 2)
        report, diagnostic = [self.b.strict_json(line, "input_schema") for line in lines]
        require(type(report.get("version")) is int and
                (report["version"] == 1 or report["version"] == 2 and report.get("boundary") == "workspace-vm") and
                report.get("profile") == "zeros-cloud-worker-v4" and report.get("qualified") is True)
        require(diagnostic.get("schema") == "zeros.diagnostic/v1" and diagnostic.get("component") == "attester" and
                diagnostic.get("ok") is True and diagnostic.get("stage") == "done" and
                diagnostic.get("exitCode") == 0 and diagnostic.get("failedChecks") == [])
        identity = report.get("runtime", {})
        require(all(identity.get(key) == active[key] for key in ACTIVE_KEYS
                    if key not in ("schema", "root", "cgroupRoot")))
        phase = "rollback_enroll" if rollback else "enroll"
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        reply = self.pipe.exchange(self.request, phase, active=active, report=report,
                                   controller=self.controller, timeout=min(15, remaining),
                                   **({"resident": self.resident} if self.resident else {}))
        require(reply["allow"] and type(reply.get("environment")) is dict)
        engine_id = validate_enrollment_environment(self.b, reply["environment"], self.request, rollback,
                                                    self.enrolled_engine_instances)
        self.enrolled_engine_instances.add(engine_id)
        resident_fields = {}
        if self.resident:
            fence = self.resident["fence"] + 1
            require(fence < 2**53)
            self.resident_enrollment = {"engineId": engine_id, "generation": self.request["scope"]["sourceGeneration" if rollback else "candidateGeneration"], "fence": fence}
            resident_fields = {"resident": {"hostId": self.resident["hostId"], "fence": fence}}
        prepared_session = self.session
        try:
            started = self.supervisor("start", session=prepared_session, environment=reply["environment"], **resident_fields)
        finally:
            # A failed or lost start can already have attached the target. Keep
            # its planned authority for exact retirement; never guess detached.
            self.session = None
        if started.get("outcome") == "rejected" and self.resident:
            self.confirm_rejected_resident_start(prepared_session)
        require(started.get("outcome") == "started")
        phase = "rollback_health" if rollback else "health"
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        resident_fields = {}
        if self.resident:
            status = self.supervisor("resident-status")
            require(status.get("outcome") == "ready")
            attached = resident_document(self.b, status.get("resident"))
            require(same_resident(attached, self.resident) and all(attached[key] == value for key, value in self.resident_enrollment.items()))
            resident_fields = {"resident": attached}
        return self.pipe.exchange(self.request, phase, active=active, timeout=remaining, **resident_fields)["allow"]

    def confirm_rejected_resident_start(self, prepared_session):
        # Rejection alone is insufficient. The same root must prove both the
        # exact unchanged detached host and the original unspent prepare. This
        # also distinguishes validation rejection from a failed/ambiguous start
        # that consumed its session or attached the candidate before replying.
        if prepared_session is None or self.resident_prepare_fields is None:
            return
        try:
            status = self.supervisor("resident-status")
            require(status.get("outcome") == "ready")
            detached = resident_document(self.b, status.get("resident"))
            require(detached == self.resident and detached["engineId"] is None)
            replay = self.supervisor("prepare", **self.resident_prepare_fields)
            require(replay.get("outcome") == "prepared" and replay.get("session") == prepared_session)
            require(resident_document(self.b, replay.get("resident")) == detached)
            self.check_retired_scope()
        except Exception:
            return
        self.session = prepared_session
        self.resident_enrollment = None


def main():
    require(sys.platform == "linux" and os.geteuid() == 0 and os.uname().machine == "x86_64" and len(sys.argv) == 1)
    os.umask(0o077)
    sys.dont_write_bytecode = True

    def interrupted(_signum, _frame):
        raise UpdateFailure()

    for signum in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    # Pre-activation work is bounded separately. Each activated path receives
    # its own watchdog, including blocking calls in the protected base helper.
    signal.alarm(900)
    # No ambient Python import path or input can select the protected installer.
    spec = importlib.util.spec_from_file_location("zeros_bootstrap", "/opt/zeros-bootstrap/bootstrap.py")
    b = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(b)
    app, pipe = b.Bootstrap(), Pipe(b)
    request = pipe.read(15)
    runtime = SystemRuntime(b, app, pipe, request)
    try:
        pipe.write(RuntimeInstaller(b, app, runtime, arm_deadline=signal.alarm).run(request))
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not forward Python tracebacks, subprocess output or installer
        # exceptions: they may contain private paths or presigned URLs.
        sys.stdout.write('{"schema":"zeros.runtime-update/v1","outcome":"failed"}\n')
        sys.exit(1)
