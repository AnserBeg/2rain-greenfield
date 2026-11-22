# AI-BUILD-1 slice 3 drafting-model bake-off

Same requests, prompt and repair code as the slice 2 run; first drafts made back to back from the captured in-app requests, each scored on the real in-app path, repairs live. One attempt per request: indicative only. Spend USD 11.1200 of a USD 12 cap.

| candidate | requests | verified first try | verified after repair | behaviour correct | hostile changed | spend | cache read tokens |
|---|---|---|---|---|---|---|---|
| sonnet-5-5 | 6 | 6/6 (100%) | 6/6 (100%) | 6/6 (100%) | 0 | $0.2761 | 168447 |

| request type | candidate | requests | success after repair | behaviour correct | cost per completed request | median model latency |
|---|---|---|---|---|---|---|
| single change | sonnet-5-5 | 1 | 1/1 | 1/1 | $0.1159 | 2.9 s |
| whole module | sonnet-5-5 | 3 | 3/3 | 3/3 | $0.0449 | 5.1 s |
| module + lines + board | sonnet-5-5 | 2 | 2/2 | 2/2 | $0.0127 | 3.1 s |
