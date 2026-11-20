"""Run one SIGNIN-1 regression control in an isolated Actions checkout."""
import sys
import subprocess
from pathlib import Path
from os import environ

case = environ['CONTROL']
staff = Path('apps/api/src/staff-identity.ts')
policy = Path('db/migrations/0047_staff_session_integrity.sql')
browser = case in ['resource', 'approver', 'executor', 'issuer', 'browser']
if case == 'baseline':
    testfile = Path('test/postgres/staff-signin.test.ts')
    expanded_tests = testfile.read_bytes()
    subprocess.run(['git','switch','--detach','13902266'],check=True)
    testfile.write_bytes(expanded_tests)
controls = {
  'rollback': (staff, "await client.query('ROLLBACK');", "await client.query(error instanceof StaffAccessRefused ? 'COMMIT' : 'ROLLBACK');", 'handoff refusal must roll back verifier consumption'),
  'prior': (staff, 'prior_application_digest IS NOT DISTINCT FROM $2::bytea', '($2::bytea IS NULL OR $2::bytea IS NOT NULL)', 'a different live ERP handle must be refused'),
  'resource': (policy, 'AND a.resource_id=s.resource_id AND', 'AND', 'recovery must match the permission resource'),
  'approver': (policy, 'WHERE principal_id=subject AND eligible AND', 'WHERE false AND', 'recovery must cover set_release_approver_eligibility'),
  'executor': (policy, 'WHERE principal_id=subject AND authorized AND', 'WHERE false AND', 'recovery must cover set_release_executor_authority'),
  'issuer': (staff, "WHEN kind='recover' THEN platform.staff_can_manage(tenant_id,environment_id,issuer_id,principal_id)", "WHEN kind='recover' THEN true", 'recovery enrollment must recheck issuer authority'),
}
expected = 'landing GET created a login transaction' if case == 'baseline' else None
if case in controls:
    path, old, new, expected = controls[case]
    original = path.read_text()
    assert original.count(old) == 1
    path.write_text(original.replace(old,new))
try:
    command = ['node','--import','tsx']
    command += ['test/helpers/staff-browser-journey.ts'] if browser else ['--test','test/postgres/staff-signin.test.ts']
    result = subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    print(result.stdout)
    if expected:
        assert result.returncode != 0 and expected in result.stdout, f'Expected failure at {expected}'
    else:
        assert result.returncode == 0
finally:
    if case in controls: path.write_text(original)
