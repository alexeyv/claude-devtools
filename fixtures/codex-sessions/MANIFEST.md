# Codex session fixtures

Complete Codex session trees captured from `~/.codex/sessions` as reference
material: each is a root rollout plus every subagent rollout it spawned.

The directory keeps Codex's own `{YYYY}/{MM}/{DD}` layout, so it works as a
drop-in sessions root:

```bash
npx tsx scripts/codex-probe.ts fixtures/codex-sessions
npx tsx scripts/codex-sweep.ts fixtures/codex-sessions
npx tsx scripts/codex-overview.ts fixtures/codex-sessions
```

These are real working sessions and are git-ignored deliberately.

## 019e9229-6e33-7313-8599-9bd35b6faa1d

- **Prompt**: you have a system prompt instruction to only use subagents when the user asks for it, yes?
- **Directory**: `/Users/alex/src/bmad`
- **Model**: GPT-5.5 (Codex CLI 0.136.0)
- **Started**: 2026-06-04T10:24:09.286Z
- **Duration**: 1h 29m
- **Subagents**: 22 across 23 files, peak 6 running at once
- **Agents**: Ramanujan, Nash, Laplace, Turing, Meitner, Descartes, Carver, Gauss, Ohm, Goodall, Kant, Hypatia, Ptolemy, Wegener, Popper, Kuhn, Cicero, Jason, Plato, Russell, Raman, Euclid
- **Root messages**: 875, 23,804,438 tokens
- **Size**: 4.2 MB

```
root           |========================================================
Euclid         |                                         ##
Raman          |                                         ##
Russell        |                                         ##
Plato          |                                         ##
Jason          |                                         ##
Cicero         |                                          #
Kuhn           |                                          ##
Popper         |                                          ##
Wegener        |                                          ###
Ptolemy        |                                          ##
Hypatia        |                                           #
Kant           |                                           #
Goodall        |                                            #
Ohm            |                                            #
Gauss          |                                            ##
Carver         |                                            ##
Descartes      |                                            ##
Meitner        |                                            #
Turing         |                                             #
Laplace        |                                             #
Nash           |                                             #
Ramanujan      |                                             ##
               +--------------------------------------------------------
               10:24                                              11:52
```

## 019fe22f-32e8-7573-927b-b62fbdd822df

- **Prompt**: $bmad-build plan-code-review route: The LLM setup dialog’s result text area expands vertically even when the result contains only a couple of lines, leaving a large amount of useless empty space. Make the result area fit
- **Directory**: `/private/tmp/adaptam-one-shot-round-004.gBjxFu`
- **Model**: GPT-5.6-sol (Codex CLI 0.147.0)
- **Started**: 2026-08-08T16:22:51.891Z
- **Duration**: 1h 45m
- **Subagents**: 11 across 12 files, peak 4 running at once
- **Agents**: Ramanujan, Banach, Linnaeus, Goodall, Pasteur, Pascal, Arendt, Noether, Laplace, Pauli, Boole
- **Root messages**: 172, 4,185,113 tokens
- **Size**: 7.2 MB

```
root           |========================================================
Boole          |###
Goodall        |                                           #############
Laplace        |                                           ########
Noether        |                                               ##
Arendt         |                                               ##
Pascal         |                                                ##
Pauli          |                                                  #
Linnaeus       |                                                    ##
Banach         |                                                    ###
Ramanujan      |                                                    ##
Pasteur        |                                                      #
               +--------------------------------------------------------
               16:22                                              18:07
```

## 01a01086-5035-7000-828d-2ed20687b5bc

- **Prompt**: $bmad-build llm setup spec, story 6
- **Directory**: `/Users/alex/src/ui.wt`
- **Model**: GPT-5.6-sol (Codex CLI 0.147.0)
- **Started**: 2026-08-17T16:20:32.970Z
- **Duration**: 4h 54m
- **Subagents**: 10 across 11 files, peak 4 running at once
- **Agents**: Carson, Epicurus, Hooke, Turing, Sagan, Banach, Beauvoir, Raman, Lovelace, Tesla
- **Root messages**: 309, 13,948,458 tokens
- **Size**: 14.6 MB

```
root           |========================================================
Tesla          |#
Lovelace       |#
Turing         | ######
Raman          | ####
Beauvoir       |   #
Banach         |   #
Sagan          |   ##
Hooke          |     ##
Epicurus       |     ##
Carson         |     ##
               +--------------------------------------------------------
               16:20                                              21:14
```

## 01a01414-8644-7ce0-9d6d-80c050a49e42

- **Prompt**: The next story I am missing is a mouse hover sort of thing on the timeline That's basically always on when the mouse is under the timeline The whole clock whatever basically it is just vertical red line that is marked wi
- **Directory**: `/Users/alex/src/claude-devtools`
- **Model**: GPT-5.6-sol (Codex CLI 0.147.0)
- **Started**: 2026-08-18T08:54:44.568Z
- **Duration**: 21h 59m
- **Subagents**: 8 across 9 files, peak 4 running at once
- **Agents**: Boole, Ramanujan, Mendel, Boyle, Schrodinger, Euclid, Socrates, Hume
- **Root messages**: 203, 5,457,077 tokens
- **Size**: 12.7 MB

```
root           |========================================================
Hume           |                                      #
Boyle          |                                                     ###
Socrates       |                                                     ###
Euclid         |                                                      #
Schrodinger    |                                                      #
Mendel         |                                                       #
Ramanujan      |                                                       #
Boole          |                                                       #
               +--------------------------------------------------------
               08:54                                              06:53
```

---

Total: 55 rollout files, 38.7 MB.
