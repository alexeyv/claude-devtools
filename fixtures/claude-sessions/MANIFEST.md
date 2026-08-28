# Claude Code session fixtures

Complete Claude Code session trees captured from `~/.claude/projects` as
reference material: each is a session file plus every subagent it spawned.

The directory keeps Claude's own layout, so it works as a drop-in projects
root — point `ProjectScanner` at it:

```ts
const scanner = new ProjectScanner('fixtures/claude-sessions');
```

These are real working sessions and are git-ignored deliberately.

## d7e16737-e086-481e-959e-de2cb40bec4f

- **Prompt**: You are running Tier 1 of a validation experiment for a proposed code-review triage design: lens-owned triage via progressive disclosure. Today the pipeline has a central judge triage all reviewer findings; the proposal
- **Directory**: `/private/tmp/devtools-auto-replay`
- **Project dir**: `-private-tmp-devtools-auto-replay`
- **Model**: claude-opus-5
- **Started**: 2026-08-18T08:57:31.480Z
- **Duration**: 26m
- **Subagents**: 25 across 51 files, peak 24 running at once
- **Subagent types**: general-purpose
- **Task calls**: 25
- **Messages**: 347, 9,104,044 tokens
- **Size**: 9.3 MB

```
main           |========================================================
Triage blind-h |    ######################
Triage edge-ca |    #####################
Triage verific |     ####################
Triage intent- |     #####################
Triage blind-h |     #################################
Triage edge-ca |     #####################
Triage verific |     #####################
Triage intent- |     #####################
Triage blind-h |      #####################
Triage edge-ca |      ####################
Triage verific |      ####################
Triage intent- |      ####################
Triage blind-h |      #####################
Triage edge-ca |       ####################
Triage verific |       ###################
Triage intent- |       ####################
Triage blind-h |       #####################
Triage edge-ca |       ####################
Triage verific |       ####################
Triage intent- |        ###################
Triage blind-h |        ####################
Triage edge-ca |        ###################
Triage verific |        ###################
Triage intent- |        ###################
Triage blind-h |                                ###########
               +--------------------------------------------------------
               08:57                                              09:23
```

## 9d343a68-5bc9-449a-b914-be578f39b95f

- **Prompt**: https://github.com/bmad-code-org/BMAD-METHOD/pull/2713 << Read this pull request, it's dive and its comments and stop.
- **Directory**: `/Users/alex/src/bmad`
- **Project dir**: `-Users-alex-src-bmad`
- **Model**: claude-fable-5
- **Started**: 2026-08-12T16:22:25.402Z
- **Duration**: 11h 19m
- **Subagents**: 83 across 167 files, peak 12 running at once
- **Subagent types**: general-purpose, claude
- **Task calls**: 83
- **Messages**: 809, 31,296,773 tokens
- **Size**: 8.4 MB

```
main           |========================================================
Route case: co |  #
Route case: st |  #
Route case: fi |  #
Route case: nu |  #
Route case: us |  #
Route case: us |  #
Route case: di |  #
Route case: di |  #
Route case: pa |  #
Route case: st |  #
Route case: st |  #
Route case: ta |  #
Route case: cr |  #
Route case: as |  #
Route case: cu |  #
Route case: wr |  #
Route case: bm |  #
Route case: ex |  #
Route case: re |  #
Route case: ve |  #
Route case: em |  #
Route case: bu |  #
Route case: cl |  #
Route case: ch |  #
Route case: RE |  #
Route case: un |  #
Eval routing c |          ##
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          ##
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          ##
Eval routing c |          #
Eval routing c |          #
Eval routing c |          ##
Eval routing c |          #
Eval routing c |          ##
Eval routing c |          ##
Eval routing c |          ##
Eval routing c |          #
Eval routing c |          ##
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          #
Eval routing c |          ##
Eval routing c |          ##
Eval routing c |          ##
Probe rebase v |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
Update bmad in |                                 #
               +--------------------------------------------------------
               16:22                                              03:41
```

## 75c33d26-691f-4e75-b43a-854ddc7b95e6

- **Prompt**: <command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args>
- **Directory**: `/Users/alex/src/bmad`
- **Project dir**: `-Users-alex-src-bmad`
- **Model**: claude-opus-5
- **Started**: 2026-08-01T11:55:35.544Z
- **Duration**: 3h 21m
- **Subagents**: 35 across 71 files, peak 8 running at once
- **Subagent types**: general-purpose
- **Task calls**: 35
- **Messages**: 488, 22,553,563 tokens
- **Size**: 5.9 MB

```
main           |========================================================
Review alder   |                             ##
Review birch   |                             #
Review cedar   |                             #
Review dogwood |                             #
Review elm     |                             ##
Review fir     |                             ##
Review gum     |                             ##
Review hazel   |                             ##
Review juniper |                              ##
Review larch   |                              #
Review maple   |                              #
Review oak     |                              #
Review pine    |                              ##
Review quince  |                              ##
Review rowan   |                              ##
Review spruce  |                              ##
Review teak    |                                      ##
Review walnut  |                                      ##
Review yew     |                                      ##
Review zelkova |                                      ##
Review walnut  |                                              #
Review yew     |                                              #
Review zelkova |                                              #
Review aspen   |                                                  ##
Review balsa   |                                                  #
Review cocoa   |                                                  ##
Review ebony   |                                                  ##
Review ginkgo  |                                                  ##
Review holly   |                                                  ##
Review ironwoo |                                                  ##
Review jarrah  |                                                  ##
Review katsura |                                                   #
Review linden  |                                                   #
Review mahogan |                                                   #
Review nutmeg  |                                                   #
               +--------------------------------------------------------
               11:55                                              15:17
```

## 394e8ede-1273-4b13-b46d-454daa87a0f1

- **Prompt**: <command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args>
- **Directory**: `/Users/alex/src/bmad`
- **Project dir**: `-Users-alex-src-bmad`
- **Model**: claude-fable-5
- **Started**: 2026-08-19T02:40:56.598Z
- **Duration**: 27h 28m
- **Subagents**: 8 across 17 files, peak 5 running at once
- **Subagent types**: general-purpose
- **Task calls**: 8
- **Messages**: 1913, 98,496,150 tokens
- **Size**: 10.7 MB

```
main           |========================================================
Aggregate code |               #
Spec reconcili |               #
Adversarial le |               #
Edge-case lens |               #
Verification-g |               #
Strip config v |                 #
Strip config v |                 #
Strip config v |                 #
               +--------------------------------------------------------
               02:40                                              06:09
```

---

Total: 306 files, 34.3 MB.
