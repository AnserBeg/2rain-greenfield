# AGENT-SPEED-1 — assistant speed in user-built modules

Base `9ac017b915d24b058a35450db92433c97486a2f7`. In progress.

## Measures registered before tuning

- Time to card starts before the assistant reads the screen and ends at the first presented card for that task. Yes-to-done runs from each granted human approval to its first successful declared read-back. Report medians, exclude tasks without the respective event, and report pass rate across all attempts.
- Calls count invocations of the five tools, including host invocations. USD per task is total metered spend divided by attempted tasks. End-to-end elapsed time includes preamble and final model summary. The existing ten-task eval also reports model-loop time.
- Route trials use tasks 1 and 14 (reads), 16 and 18 (single creates), three attempts each on Opus high, Opus low and Sonnet low. Compare read and single-operation tasks separately against Opus high on the same inputs. An adopted route must preserve each selected task's pass count.
- Generate the proof set from declarations only after freezing the assistant. Run the identical generator on baseline and candidate. Compare the medians and end-state pass rates of matched first-party and generated journeys. Inspection is excluded.

## Routing

Three attempts per task (36 runs). Opus high, Opus low, Sonnet low each passed 6/6 reads and 6/6 creates. Median elapsed seconds in that order were 5.801, 5.829, 6.890 for reads and 5.963, 4.041, 3.122 for creates. Total USD by route was 0.3752, 0.2432, 0.1826. Short single-create requests use Sonnet low. Reads, compound requests and explicit model overrides retain high effort. Prices are from [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing).

## Test it yourself

1. Ask the panel to archive a record. Check the card, click Yes, and observe execution and read-back before the next model response. Decline another card and check the record remains active.

2. Run `node --import tsx --test --test-name-pattern="measured create route|switching model prices" test/agent/operations-agent.test.ts` to check routing and the shared cap.

3. Run `node --import tsx --test --test-name-pattern="parallel reads" test/agent/business-map.test.ts`. It observes overlapping reads, ordered results and refusal of a wrong-type reference.

4. Run `node --import tsx test/agent/map-size.ts`. The 50-type compiled release produced 55,482 characters in the previous map, 21,863 in the summary and 409 in a selected detail. The initial structure build took 28.7 ms on this host.

5. Run `node --import tsx --test --test-name-pattern="an active action must be exposed" test/unit/customization.test.ts`. The compiled application passes, and removing Item create from assistant discovery refuses activation.

## Filed

Atomic create with lines (CUSTOMIZE-4 Option A), recipes after WORKFLOW-1, and habit-based shortcuts after durable run records.
