# Patchvane

An upstream patch tracker. It follows every patch you posted to a kernel
mailing list from the moment it went out to the moment it lands in Linus'
tree, and tells you which ones are waiting on you.

Everything comes from public sources. No local kernel tree, no mail spool, no
submission directory: copy this folder to any machine with Python 3 and an
internet connection and it works. Nothing outside the standard library is
needed.

## Running it

```bash
cd patchvane
python3 serve.py            # then open http://127.0.0.1:8787
```

There is no install step. `requirements.txt` is there and lists nothing,
because the whole of this runs on the Python standard library: no requests,
no web framework, no crypto library. All it wants is Python 3.10 or newer.

Sign in, and it starts collecting the patches you posted from that address.
The first run takes a few minutes because it reads the whole lore archive for
you. After that the server keeps collecting on a timer, so the page stays
current on its own.

There is nothing to configure first. It does not need to be told who you are,
because signing in tells it.

On WSL, `http://127.0.0.1:8787` opens straight from the Windows browser
because WSL2 forwards localhost. If it does not, run
`python3 serve.py --host 0.0.0.0` and use the address from `hostname -I`.

```bash
python3 serve.py --port 9000     # somewhere else
python3 serve.py --interval 5    # collect every five minutes
python3 serve.py --no-auto       # only collect when you ask
```

## Signing in

Two ways in, and the sign-in page lets you pick between them.

**A Gmail address and a Google app password.** Not your account password;
Google refuses those over IMAP. Create one at
`myaccount.google.com/apppasswords`. The password goes to Gmail to be
checked and is then discarded.

**A passphrase.** Make one with `python3 serve.py --hash-passphrase`, which
prints the `PATCHVANE_PASSPHRASE_HASH` to export. Useful where the host blocks
outbound IMAP, which several providers do. A passphrase says you may come in
but not who you are, so that form also asks which address to track.

Either is enough on its own. `PATCHVANE_REQUIRE_BOTH=1` turns that into an
"and", for anyone who wants the second factor.

Only a signed session token is kept, in a cookie, and the server holds no
session table. The server listens on `127.0.0.1` by default, so nothing else
on the network can reach it.

## Whose patches it shows

Yours, and it works out which those are from how you signed in. There is no
address to configure and nothing to edit: sign in with your Gmail address and
you get a dashboard of the patches you posted from it.

The same server does this for everybody who signs in. Each address gets its
own directory under `people/`, holding its own collected patches, its own
notes and its own API keys, and one person's cookie only ever reaches their
own. Nobody sees anybody else's dashboard, and there is no shared one.

The first time an address signs in there is nothing to show yet, because
reading every thread it ever posted takes a few minutes. The page says so,
waits, and opens itself when the collection lands. After that it is kept
current on a timer along with everyone else's, one at a time so that this
host does not fetch from lore several times over at once.

The name you are greeted by comes from the `From:` line on your own patches,
whichever form of it you use most often.

A dashboard nobody has signed into for a fortnight stops being refreshed;
signing in again resumes it. `PATCHVANE_KEEP_DAYS` changes that.

### Keeping it to particular people

Anyone who can log into a mailbox can get a dashboard of that address's
patches, which is the point, and an address nobody holds the password to is
no use to a stranger. A shared or public deployment can still narrow it to a
list:

```sh
export PATCHVANE_ALLOW_EMAILS=colleague@gmail.com,someone.else@gmail.com
```

or `config.json` under `signin.emails`. An address not on the list is turned
away before Gmail is ever contacted, and the refusal does not name the
addresses that would have worked.

## Where the numbers come from

| Source | What it answers |
| --- | --- |
| `lore.kernel.org` | Every message you posted and every reply in those threads: who is reviewing, which tags you were given, who said "applied" |
| `patchwork.kernel.org` | The review state a maintainer set on a patch, and CI results |
| `git.kernel.org` | Whether the commit is in Linus' tree, in `linux-next`, or still only in a maintainer's own tree |

A patch moves through these, worst to best:

```
no reply yet  →  in discussion  →  reviewed  →  accepted
              →  in maintainer tree  →  in linux-next  →  in mainline
```

`in mainline` means it is in Linus' tree. `in linux-next` means a maintainer
took it and it is lined up for the next merge window. `in maintainer tree`
means it is in their tree but has not reached linux-next yet.

## The seven sections

| | |
| --- | --- |
| **Overview** | Where everything stands, with the numbers adding up to the total |
| **Your turn** | Threads owed a reply, series owed a new version, and your own notes |
| **Patches** | Every patch, filtered by status, subsystem or tree |
| **Outcomes** | What landed and where it sits, and what was dropped and why |
| **Discussions** | Threads, the people who replied, and the review tags you collected |
| **Insights** | When you post, which subsystems you touch, how each tree is doing |
| **Settings** | Refresh schedule, the assistant, and the health of each source |

Press `?` for the keyboard shortcuts. `1` to `7` jump between sections, `/`
searches the table on screen, `a` opens the assistant, `r` refreshes.

## Refreshing

The server collects on a timer, every fifteen minutes by default. Turn it off
or change the interval on **Settings → General**, or press `r` for a run right
now. Responses are cached under `cache/`, so a scheduled run only fetches what
changed and usually finishes in about a second.

Collecting from the command line still works:

```bash
python3 collect.py --quick        # mainline and linux-next only, fastest
python3 collect.py --fresh        # ignore the cache
python3 collect.py --all-trees    # search every maintainer tree, slow
python3 collect.py lore           # one source only
python3 collect.py --standalone   # also write a single-file dashboard.html
```

`--all-trees` asks cgit to search each maintainer tree by author, which makes
git.kernel.org walk the whole history and can take minutes per tree. The
default does not need it: `linux-next` already carries every maintainer's
`-next` branch, and where patchwork knows the commit hash the tree is asked
about that one hash instead, which is a single fast request.

`--standalone` writes `dashboard.html` with the data baked in, openable with no
server and no sign-in. Treat that file as public.

## The assistant

**Settings → Assistant** lists every model the dashboard can talk to. Add an
API key for any of them and it becomes available:

| | Key from | Environment variable |
|---|---|---|
| OpenAI | `platform.openai.com/api-keys` | `OPENAI_API_KEY` |
| Claude | `console.anthropic.com/settings/keys` | `ANTHROPIC_API_KEY` |
| Gemini | `aistudio.google.com/apikey` | `GEMINI_API_KEY` |
| Grok | `console.x.ai` | `XAI_API_KEY` |
| DeepSeek | `platform.deepseek.com` | `DEEPSEEK_API_KEY` |
| Mistral | `console.mistral.ai` | `MISTRAL_API_KEY` |
| Groq | `console.groq.com/keys` | `GROQ_API_KEY` |
| OpenRouter | `openrouter.ai/keys` | `OPENROUTER_API_KEY` |
| Perplexity | `perplexity.ai/settings/api` | `PERPLEXITY_API_KEY` |
| Cohere | `dashboard.cohere.com/api-keys` | `COHERE_API_KEY` |
| Together AI | `api.together.ai` | `TOGETHER_API_KEY` |
| Fireworks | `fireworks.ai/account/api-keys` | `FIREWORKS_API_KEY` |
| Cerebras | `cloud.cerebras.ai` | `CEREBRAS_API_KEY` |
| NVIDIA NIM | `build.nvidia.com` | `NVIDIA_API_KEY` |
| SambaNova | `cloud.sambanova.ai` | `SAMBANOVA_API_KEY` |
| Moonshot (Kimi) | `platform.moonshot.ai` | `MOONSHOT_API_KEY` |
| Z.ai (GLM) | `z.ai/manage-apikey/apikey-list` | `ZHIPU_API_KEY` |
| Qwen | `bailian.console.alibabacloud.com` | `DASHSCOPE_API_KEY` |
| Hugging Face | `huggingface.co/settings/tokens` | `HF_TOKEN` |
| Azure OpenAI | `portal.azure.com` | `AZURE_OPENAI_API_KEY` |

One key is enough; the rest stay folded away until you go looking. The
environment wins over anything typed into the page, so a deployment can pin a
key the page cannot replace. **Test** on each card does one cheap round trip
and tells you whether the key works.

Azure gives every deployment its own hostname, so it also needs
`ai.endpoints.azure` in `config.json` pointing at yours. The same setting
works for anything else behind a company gateway.

### Asking it things

It is a conversation, not a row of unrelated questions. Each question goes to
the model with the dozen turns before it, so a follow-up can leave its subject
out the way people do: ask what a maintainer's reply means, then "what should
I say back", then "and the hyperv one?", and each lands where you meant it.
Anything you tell it that the dashboard does not know, such as a request made
off-list, it takes at its word for the rest of the conversation.

Every question also carries a digest of the whole contribution: the totals, the
trees, what landed, the threads waiting on you, and one line per patch. That is
enough for "how many" and "where does this stand", and not enough for "what did
the reviewer ask me to change", because the asking happened in a message a
summary has no room for. So the threads your question is about are looked up
and quoted in full underneath it: every version, and every reply with who wrote
it. Ask what to change in the next spin and it answers from what the reviewer
actually wrote.

Your own notes are in the digest too, which is worth remembering when the
answer cites a rule you wrote down somewhere else.

### Picking a model

The assistant has a picker next to the message box. On **Auto** the question
is read for what kind of question it is, and the models suited to it go
first:

| The question is about | Asked in this order |
|---|---|
| code, diffs, build failures | Claude, DeepSeek, OpenAI, Gemini |
| drafting a reply | Claude, OpenAI, Gemini |
| working something out | OpenAI, Claude, Gemini, Grok |
| counting and listing | Gemini, OpenAI, Groq, Claude |

Models with no key are skipped. If one is rate limited or overloaded it is
asked once more after a short pause, and then the question moves to the next
model; the answer says who ended up giving it, and who could not. Choosing a
model by name pins it to the front of that order without turning it into a
single point of failure.

### Reading the threads

A patch's status comes from three kinds of evidence, and they are not equally
trustworthy:

1. **A commit in a tree.** A fact. Never questioned.
2. **A state somebody set in patchwork.** Nearly always right, but it goes
   wrong in one particular way: a patch sent to one subsystem gets picked up
   by another subsystem's patchwork instance and marked `not-applicable`
   there, while the maintainer who owns the code is busy applying it. A
   sched_ext patch caught by netdev's patchwork looks rejected when Tejun
   has already taken it.
3. **A maintainer writing in English.** Read with regular expressions, which
   handle "Applied, thanks" and miss "I've taken this into my tree for the
   next merge window" or "please send this via net-next instead".

If a key is configured, the collector asks a model about the third kind, and
about the second kind when somebody in the thread says they took the patch.
It sees the whole history: every version, what each was told, and what was
said on the series cover letter, which is where "Applied 1-2 to
sched_ext/for-7.4" usually arrives.

It may only answer with a status the dashboard already knows, an unrecognised
answer is discarded, and every status decided this way carries a `READ` badge
in the patch list so a reading is never mistaken for a record.
**Settings → Assistant** shows how many came from each. Answers are cached
against the thread's contents, so a collection only asks about threads that
gained a reply, a version or a new patchwork state.

`collect.py --no-ai` turns it off; so does having no key, in which case the
regular expressions have the final word as before. `ai.classify_limit` in
`config.json` caps how many threads one collection may ask about.

### Versions of the same patch

Resending a patch as v2 does not create a second patch. Every version is
matched by subject, and the newest one speaks for the work: earlier ones read
as *superseded*, saying which version replaced them. This matters for the
totals — without it an abandoned v1 sits in "no reply yet" for ever.

A commit is credited to the version that was actually applied, worked out
from the date: the newest version sent before the commit was made. Without
that, one accepted patch is counted once per version that shares its subject.
A version that genuinely landed keeps its commit even if a later one was
sent.

### Whose commit it is

Being named on a thread is not the same as having written the patch, and the
difference is where a tracker like this quietly goes wrong. Three checks keep
a commit from being credited to the wrong person:

- git.kernel.org is asked for commits by your address, and the answer is
  checked rather than trusted: the log carries an author column, and a row
  authored by somebody else is dropped however it came back.
- A maintainer replying "applied, thanks" is only believed when the patch
  they are applying is one you posted. Threads carry other people's series —
  ones you were copied on, ones you reviewed — and the reply in those is
  about their work, not yours.
- A commit whose subject was reworded on the way in is still matched to the
  patch it came from, but only on a distinctive prefix, cut at a word
  boundary, and only when exactly one patch matches. Two candidates mean it
  cannot be told which, and it is left uncredited rather than guessed.

Patches counted this way carry the author the commit was actually written
under, so a wrong one is visible rather than silent.

### When a source cannot be reached

If git.kernel.org does not answer, the collector keeps the last answer it got
rather than reporting no commits, because "no commits" silently moves every
merged patch back to unmerged. When that happens the page says so, on the
overview and under the timestamp, naming the host it could not reach.

### What is sent

Every question goes out with a digest of what the dashboard collected:
totals, per tree numbers, landed commits, open threads, review tags, your
notes, and a one line summary of each patch. That is around fifty kilobytes.
No mail bodies, no credentials and no patch contents leave the machine.
Reviewer addresses are masked first. The model is told to answer only from
the digest and to say so when the answer is not in there.

Useful things to ask:

- What needs my attention today?
- Which series are stuck and why?
- What should change in v2 of this series?
- Summarise the review feedback I have received.
- Which trees have accepted the most of my work?

### Your key is yours

A key you add is yours alone. It is written into your own vault under
`people/`, encrypted with the server's secret, mode `0600`, and it is only
ever spent on your questions and your collections. Somebody else signing in
to the same server is asked for their own; they are never quietly handed
yours, and they cannot read it.

Tick "remember this" and the key survives a restart. Leave it and it lives in
memory until the server stops. Either way, nothing about it reaches another
account.

The encryption covers the key where it sits: a stolen disk, a stray backup or
a copied directory gives up nothing without `PATCHVANE_SECRET`. It cannot
cover the running server, which has to decrypt the key in order to use it.
Nothing that keeps a usable key on a machine can claim otherwise.

If a model you picked stops existing, and providers retire them often, press
**Test** in Settings. It finds one on your key that does answer and moves you
onto it rather than leaving you with a dead setting.

An operator who would rather supply one set of keys for everybody can set
`PATCHVANE_SHARED_KEYS=1`, and then a key in the environment fills in for
anyone who has not added their own. It is off by default.

## Where the numbers come from

**Overview → Where all N patches stand** puts every patch in exactly one
bucket, and prints the sum so you can see it balance:

| Bucket | Means |
|---|---|
| In mainline | the commit is in Linus' tree |
| Accepted, on the way | a maintainer took it; heading for a merge window |
| Being reviewed | someone is looking at it, or has already tagged it |
| Needs a new version | changes were requested, so a v2 is owed |
| No reply yet | posted, and nobody has said anything |
| Dropped | superseded, rejected, or picked up somewhere else |

Clicking a bucket opens exactly those patches. If a patch ever lands in a
state the dashboard does not know about it appears as **Unaccounted** rather
than quietly going missing from the total.

The funnel above it is a different thing: it counts how far each patch got,
so a patch in mainline is also counted at every earlier stage. Only the
buckets are meant to add up.

**Your turn** is what you owe the lists: threads where somebody asked you
something last, and series where changes were requested, each with the
version number the next posting should carry.

### When no reply is owed

A kernel list is read by thousands of people, and a reply that tells nobody
anything wastes all of their attention. Maintainers treat acknowledgements as
noise, so "thanks for applying" is the wrong answer to good news; silence is
the right one. Nothing that has been applied, reviewed without a question,
superseded or turned down appears in **Your turn**, and the assistant will
not draft you a thank-you note for one.

Working out which is which is harder than it sounds, because maintainers say
it however they like and the branch is whatever they called it:

    Applied 1-2 to sched_ext/for-7.4.

Nothing in that names a staging branch, the patch numbers sit between the
verb and the tree, and the message opens with "Hello," on its own line so a
glance at the first line shows nothing at all. Three things stop it being
read as a request:

- the phrasings are matched with the patch range allowed for, so "applied
  1-2 to", "applied patches 1-3 to" and "applied 1,2 and 4 to" all read as
  applied;
- a settled state closes the thread whatever the prose says, worked out
  after a model has read the thread rather than before, which is where this
  used to go wrong;
- what is still unclear goes to a model, which is asked the question
  directly: is anybody actually waiting on this person, or would a reply be
  noise? Threads it reads as needing nothing drop out.

The first run of this on a real account took **Your turn** from 38 threads to
10, and the 10 that remain are all somebody asking a question, requesting a
change, or waiting on an answer.

With no API key the first two still apply; only the third is skipped.

### Reading a patch without leaving the page

Clicking a subject anywhere — a patch, a thread, a commit that landed —
opens the whole thing here rather than throwing you at lore in another tab.
It leads with what the patch actually needs from you, then the commit and
which trees carry it, the versions you sent, the rest of the series, and the
conversation in full with the quoted patch folded down. **Open in lore** is
in the corner for the original.

Nothing is fetched until you ask for it, and the message id is checked
against your own patches first, so the endpoint cannot be used to fetch
arbitrary threads or to find out what anybody else is tracking.

## Configuring

`config.json`

- `app_name`, `app_tagline` — what the sign-in page and window title say
- `email`, `name` — whose contributions to track, and who may sign in
- `signin.emails` — narrow sign-in to these addresses; empty means anyone
  who can log into their own mailbox
- `cache_hours` — how long a fetched response stays fresh
- `auto_refresh_minutes` — how often the server collects on its own
- `netdev_outstanding_cap` — the limit `maintainer-netdev.rst` asks for, shown
  as a gauge on **Insights → Trees**
- `ai.models` — which model each provider uses. **Settings → Assistant**
  writes this: a card with a key offers *change*, which lists what that key
  can actually reach and remembers what you pick, e.g. `"openai": "gpt-5.6-sol"`;
  leave a provider out to use its default
- `ai.endpoints` — point a provider at a different address, for a company
  gateway or a regional endpoint that speaks the same wire format
- `ai.classify_limit` — how many unclear threads one collection may ask a
  model about
- `korg.trees` — maintainer trees the hash probe may ask about

`notes.json` fills **Your turn → Your notes** with things no API knows: what is blocked,
what you are waiting on, what to fix before the next respin. Each entry takes
a `title`, `state` (`blocked`, `todo`, `waiting`, `held`, `rule`), `detail`,
`next` and `tree`.

## Files

```
collect.py    gathers everything, writes data.json
serve.py      web server, Gmail sign-in, refresh timer, assistant routes
index.html    the dashboard shell
login.html    sign-in page
app.js        views, tables and charts, no dependencies
ui.js         data grid, charts and animation engine
style.css     dark and light themes
config.json   what to collect
providers.py  the models the assistant can use, and the failover between them
aiclass.py    asks a model about threads the regular expressions could not read
vault.py      per-person secrets, encrypted where they sit
requirements.txt  empty on purpose: the standard library is the whole of it
cache/        fetched responses, safe to delete
people/       one directory per signed-in address: their patches, their notes
              and their own encrypted vault.json of API keys (mode 0600)
```
