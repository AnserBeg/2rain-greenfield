# AGENT-SPEED-1 — assistant speed in user-built modules

Base `9ac017b915d24b058a35450db92433c97486a2f7`. In progress.

## Measures registered before tuning

- Time to card starts before the assistant reads the screen and ends at the first presented card for that task. Yes-to-done runs from each granted human approval to its first successful declared read-back. Report medians, exclude tasks without the respective event, and report pass rate across all attempts.
- Calls count invocations of the five tools, including host invocations. USD per task is total metered spend divided by attempted tasks. End-to-end elapsed time includes preamble and final model summary. The existing ten-task eval also reports model-loop time.
- Route trials use tasks 1 and 14 (reads), 16 and 18 (single creates), three attempts each on Opus high, Opus low and Sonnet low. Compare read and single-operation tasks separately against Opus high on the same inputs. An adopted route must preserve each selected task's pass count.
- Generate the proof set from declarations only after freezing the assistant. Run the identical generator on baseline and candidate. Compare the medians and end-state pass rates of matched first-party and generated journeys. Inspection is excluded.

## Test it yourself

1. Ask the panel to archive a record. Check the card, click Yes, and observe execution and read-back before the next model response. Decline another card and check the record remains active.

## Filed

Atomic create with lines (CUSTOMIZE-4 Option A), recipes after WORKFLOW-1, and habit-based shortcuts after durable run records.
