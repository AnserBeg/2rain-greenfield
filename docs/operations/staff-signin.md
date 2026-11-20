# Run the staff sign-in pilot

Use one installed tenant/environment with a verified serving release and the current migrations.
Use a dedicated pilot database. The first committed identity-mode claim fixes the mode for every environment in that database.
The pilot serves the ERP and identity service as two HTTPS processes. Both can run on one host.
Set these deployment values for the installer and both processes.

| Setting | Value |
| --- | --- |
| `STAFF_TENANT_ID`, `STAFF_ENVIRONMENT_ID` | IDs of the installed environment |
| `STAFF_ERP_ORIGIN`, `STAFF_IDENTITY_ORIGIN` | Fixed HTTPS origins with distinct hostnames, including a non-default port when used |
| `STAFF_RP_ID` | The registrable parent of the identity host that the owner intends to keep. Use `localhost` for the local identity test. Changing the RP ID requires enrolling new keys. |

Run the installer separately with `STAFF_INSTALLER_DATABASE_URL` for the installation role.
Set `STAFF_OWNER_NAME`, `STAFF_VERIFIED_RECOVERY_CONTACT` and `STAFF_INVITATION_FILE` to a new
file in an owner-only directory. Run `corepack pnpm --filter @north-star/api staff bootstrap`.
Give the short-lived link in that file to the verified owner in person. Remove it after delivery.
Bootstrap creates the owner and member policy roles. Provision business permissions and
company scope on those roles using the existing policy grants before serving business records.

Provide each process its own `STAFF_TLS_CERT_FILE` and `STAFF_TLS_KEY_FILE` for its hostname.
Configure PostgreSQL client authentication separately for each service login. Give the ERP
process only `STAFF_RUNTIME_DATABASE_URL` as `north_star_runtime`. When the identity host uses a
private CA, set the ERP’s `STAFF_IDENTITY_CA_FILE` to the trusted CA certificate. Give the identity
process only `STAFF_IDENTITY_DATABASE_URL` as `north_star_identity`.
For each service, set `STAFF_RATE_KEY_FILE` to a protected file of at least 32 random bytes.
Use a stable key shared by replicas of the same service.
Use separate service accounts and restrict access to each process’s files and database login.

Run `corepack pnpm --filter @north-star/api staff identity` and
`corepack pnpm --filter @north-star/api staff erp` in separate processes. Each binds to
loopback by default. Set `STAFF_BIND_ADDRESS` when binding directly to a pilot interface.
Browser and ERP backchannel clients must trust the identity certificate. For direct connections the attempt limit uses
the TCP peer. Behind an ingress, set `STAFF_TRUSTED_INGRESS_ADDRESSES` to its comma-separated
IP addresses and configure it to overwrite `X-Real-IP` with one verified client address on every
request. A missing or invalid address from a listed ingress refuses the attempt.
Keep bodies, query strings, fragments, cookies and enrollment links out of diagnostics.

The owner opens the invitation, chooses **Create a passkey**, follows **Sign in to the ERP**,
chooses **Continue to staff sign-in**, and confirms the passkey again. **Manage sign-in** offers spare keys, lost-key revocation and
sign-out everywhere. **Manage staff** lets the owner invite, deactivate and recover a member.
For attended recovery, check the person and notify them and the owner via their established
channels. Record the reason and delivery reference. The replacement keeps the same principal.
For sole-owner recovery, the installer verifies the saved contact, supplies the same contact,
`STAFF_OWNER_PRINCIPAL`, `STAFF_RECOVERY_REASON` and a new invitation file, then runs
`corepack pnpm --filter @north-star/api staff recover-owner`.

This checkpoint covers staff sign-in. The five proof-gated decisions await SIGNIN-1 slice 2.
