# Oathweave conformance vectors

`oathweave/vectors.json` holds a test JWKS and pre-signed Oathweave access tokens with the
outcome every suite verifier must produce. `oathweave/jwks.json` is the same JWKS on its own.

All tokens are synthetic: the issuer is `https://oathweave.example.test`, the audience is
`conformance`, and the signing keys were discarded after generation. Evaluate them at the fixed
time in `now` (`2026-01-01T00:00:00Z`), because Oathweave tokens live at most fifteen minutes.

| Vector | Expected |
| --- | --- |
| `valid-user` | accept, user principal |
| `valid-service` | accept, service principal (client ID equals subject) |
| `expired` | 401 `expired` |
| `not-yet-valid` | 401 `not_yet_valid` |
| `wrong-audience` | 401 `invalid_audience` |
| `wrong-issuer` | 401 `invalid_issuer` |
| `bad-signature` | 401 `invalid_signature` |
| `unknown-kid` | 401 `unknown_key` |
| `alg-none` | 401 `algorithm_not_allowed` |
| `hs256-confusion` | 401 `algorithm_not_allowed` |
| `lifetime-too-long` | 401 `invalid_lifetime` |
| `user-without-session` | 401 `invalid_claims` |

Run them with `runOathweaveConformance()` from `@hivemagnus/hive-common/oathweave/conformance`.
Regenerate with `npm run vectors:generate` in the HiveCommon repository; that replaces every
token and key, so it is a changelog-worthy change.
