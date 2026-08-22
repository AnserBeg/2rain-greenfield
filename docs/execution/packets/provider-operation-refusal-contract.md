# provider-operation-refusal-contract — opening evidence

Date filed: 2026-08-20

Status: planned; not executed by `web-refusal-taxonomy`

Tier: Critical

## Why this is a separate packet

`ModuleRuntimeInterpreterError.code` is `string`, not a closed union. Closing it
requires a provider-owned registration path for module extensions and is a
provider contract change. Two concurrent lanes owned
`packages/postgres-provider` when this was found, so the web packet stopped and
the user routed the contract work here.

This census is the packet's opening evidence. **Do not re-derive it when the
packet starts.** Re-measure only as an explicit comparison against this frozen
opening set, so drift is evidence rather than a silently replaced baseline.

## Frozen census: 61 explicitly discoverable refusal codes

At the web packet's base, the provider contains 60 distinct `MODULE_*` literals
in the module runtime interpreter and one registered extension code in the
inventory provider mapping. The contract is still open despite this finite
source census.

### Module runtime interpreter — 60

1. `MODULE_AGGREGATE_ANCHOR_INVALID`
2. `MODULE_AGGREGATE_CONTRACT_INVALID`
3. `MODULE_AGGREGATE_GENERATION_CHANGED`
4. `MODULE_AGGREGATE_GENERATION_INVALID`
5. `MODULE_AGGREGATE_IDENTITY_INVALID`
6. `MODULE_AGGREGATE_NUMERIC_OVERFLOW`
7. `MODULE_AGGREGATE_RESULT_INVALID`
8. `MODULE_ARCHIVE_RESTRICTED`
9. `MODULE_ARTIFACT_DIGEST_MISMATCH`
10. `MODULE_ARTIFACT_NOT_CANONICAL`
11. `MODULE_ENTITY_UNSUPPORTED`
12. `MODULE_ENUM_VALUE_INVALID`
13. `MODULE_FIELD_UNSUPPORTED`
14. `MODULE_FIELD_VALUE_INVALID`
15. `MODULE_FOLDED_COLUMN_CONTRACT_INVALID`
16. `MODULE_FOLDED_COLUMN_CONTRACT_MISSING`
17. `MODULE_FOLDED_MATCH_COLUMNS_REQUIRED`
18. `MODULE_INPUT_MALFORMED`
19. `MODULE_LEGAL_ENTITY_CREATE_INACTIVE`
20. `MODULE_LEGAL_ENTITY_READ_SCOPE_NOT_FOUND`
21. `MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED`
22. `MODULE_LIST_PROJECTION_INVALID`
23. `MODULE_LIST_RESULT_INVALID`
24. `MODULE_MUTATION_PRECONDITION_FAILED`
25. `MODULE_MUTATION_READ_BACK_MISSING`
26. `MODULE_OPERATION_PRECONDITION_REFUSED`
27. `MODULE_OPERATION_PRECONDITION_UNSUPPORTED`
28. `MODULE_PATCH_EMPTY`
29. `MODULE_PINNED_RELEASE_MISSING`
30. `MODULE_PROVIDER_ERROR_MAPPING_INVALID`
31. `MODULE_PROVIDER_FAILURE`
32. `MODULE_QUERY_FILTER_PLAN_INVALID`
33. `MODULE_QUERY_PARAMETER_MISSING`
34. `MODULE_QUERY_RESULT_INVALID`
35. `MODULE_RECORD_MALFORMED`
36. `MODULE_RECORD_NOT_FOUND`
37. `MODULE_RELATION_TARGET_NOT_FOUND`
38. `MODULE_RELATION_UNSUPPORTED`
39. `MODULE_RELATION_VIOLATION`
40. `MODULE_REQUIRED_FIELD_CLEAR_FORBIDDEN`
41. `MODULE_REQUIRED_FIELD_MISSING`
42. `MODULE_REQUIRED_RELATION_MISSING`
43. `MODULE_REQUIRED_SYSTEM_INPUT_MISSING`
44. `MODULE_RESOLVE_MATCH_AUTHORITY_REQUIRED`
45. `MODULE_RESOLVE_MATCH_KEY_UNSUPPORTED`
46. `MODULE_REVISION_CONFLICT`
47. `MODULE_ROLE_ASSUMPTION_INVALID`
48. `MODULE_ROLE_ASSUMPTION_SOURCE_INVALID`
49. `MODULE_ROLE_MISSING`
50. `MODULE_ROLE_RESET_FAILED`
51. `MODULE_SEARCH_CAPABILITY_UNAVAILABLE`
52. `MODULE_SEMANTIC_CONTRACT_UNSUPPORTED`
53. `MODULE_STORAGE_COLUMN_AUTHORITY_CONFLICT`
54. `MODULE_STORAGE_IDENTIFIER_INVALID`
55. `MODULE_STORAGE_PROJECTION_MALFORMED`
56. `MODULE_STORAGE_PROJECTION_MISSING`
57. `MODULE_STORAGE_TARGET_MALFORMED`
58. `MODULE_UNIQUE_VIOLATION`
59. `MODULE_VALUE_MALFORMED`
60. `MODULE_VALUE_UNSUPPORTED`

### Current extension registration — 1

61. `INVENTORY_BASE_UNIT_IMMUTABLE`

## Packet opening question

Define the closed provider/runtime refusal contract and the registration path
by which a module extension adds a code, then gate that contract against the web
presentation boundary. The code-bearing `OPERATION_REFUSED` residual remains a
safety net for skew; it is not evidence that every known refusal has useful
operator copy.
