"""Evaluate fixed seccomp_data inputs offline with the host libseccomp compiler."""
import ctypes as c
import json
import struct
import tempfile

import runtime


def check_compat_decisions():
    profile = json.loads(runtime.PROFILE.read_text())
    assert profile["architectures"] == ["SCMP_ARCH_X86_64"]
    assert profile["defaultAction"] == "SCMP_ACT_ERRNO"
    lib = c.CDLL("libseccomp.so.2")
    lib.seccomp_init.restype = c.c_void_p
    deny = 0x00050000 | profile["defaultErrnoRet"]
    allow = 0x7fff0000  # SECCOMP_RET_ALLOW
    ctx = c.c_void_p(lib.seccomp_init(deny))
    assert ctx
    try:
        # Dropping argument predicates from ALLOW and omitting explicit ERRNO
        # rules gives an upper bound on what the installed profile can admit.
        for rule in profile["syscalls"]:
            assert rule["action"] in ("SCMP_ACT_ERRNO", "SCMP_ACT_ALLOW")
            if rule["action"] != "SCMP_ACT_ALLOW":
                continue
            for name in rule["names"]:
                nr = lib.seccomp_syscall_resolve_name(name.encode())
                assert nr != -1, name
                assert lib.seccomp_rule_add(ctx, allow, nr, 0) == 0, name
        with tempfile.TemporaryFile() as out:
            assert lib.seccomp_export_bpf(ctx, out.fileno()) == 0
            out.seek(0)
            program = list(struct.iter_unpack("=HBBI", out.read()))
    finally:
        lib.seccomp_release(ctx)

    def decision(arch, nr):
        fields = {0: nr, 4: arch}  # offsetof(seccomp_data, nr/arch)
        pc = 0
        while pc < len(program):
            op, yes, no, k = program[pc]
            pc += 1
            if op == 0x20:  # LD W ABS
                a = fields[k]
            elif op == 0x05:  # JA
                pc += k
            elif op in (0x15, 0x25, 0x35, 0x45):  # JEQ, JGT, JGE, JSET
                test = {0x15:a == k, 0x25:a > k, 0x35:a >= k, 0x45:bool(a & k)}
                pc += yes if test[op] else no
            elif op == 0x06:  # RET K
                return k
            else:
                raise AssertionError(f"unrecognized BPF instruction {op:#x}")
        raise AssertionError("seccomp filter has no verdict")

    native = lib.seccomp_arch_resolve_name(b"x86_64") & 0xffffffff
    assert decision(native, lib.seccomp_syscall_resolve_name(b"getpid")) == allow
    for abi, syscall in [(b"x32", b"socket"), (b"x86", b"socketcall")]:
        arch = lib.seccomp_arch_resolve_name(abi) & 0xffffffff
        # Resolve multiplexed names to their actual kernel entry on i386.
        nr = lib.seccomp_syscall_resolve_name_rewrite(arch, syscall)
        assert nr >= 0
        audit_arch = native if abi == b"x32" else arch
        assert decision(audit_arch, nr) in (deny, 0, 0x80000000), (abi, syscall)
    assert decision(lib.seccomp_arch_resolve_name(b"x86"), 359) in (deny, 0, 0x80000000)  # i386 direct socket
    print("Offline seccomp decisions deny x32 socket and i386 socket/socketcall.")
