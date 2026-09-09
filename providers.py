"""Talking to whichever model has a key.

Every provider here is reachable with nothing but an API key, and they answer
in one of three wire formats: OpenAI's chat completions, Anthropic's messages,
or Google's generateContent.  Most of the industry copied OpenAI's, so one
adapter covers the majority and the base URL is all that changes.

Nothing in here knows about kernel patches.  It takes a system prompt, a
question, and a key, and returns an answer or a reason there is not one.
"""

import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request


class Answer:
    """What came back, or why nothing did."""

    def __init__(self, ok, text="", status=0, detail="", retry=False,
                 wait=0.0):
        self.ok = ok
        self.text = text
        self.status = status        # HTTP status, 0 when we never got one
        self.detail = detail        # short human sentence, safe to display
        self.retry = retry          # worth trying a different provider
        self.wait = wait            # seconds the provider asked us to wait

    def __repr__(self):
        return "Answer(ok=%r, status=%r, detail=%r)" % (
            self.ok, self.status, self.detail)


# A provider that hands back one of these is having a bad day rather than
# refusing us, so the caller should move along to the next one.
TRANSIENT = {408, 409, 425, 429, 500, 502, 503, 504, 529}

# Of those, the ones that usually clear on their own within seconds, and so
# are worth asking the same provider about a second time.
BUSY = {429, 500, 502, 503, 504, 529}

RETRIES = 2          # attempts per provider, not per question
BACKOFF = 2.0        # seconds before the second attempt


class Provider:
    def __init__(self, pid, label, flavour, base, default, key_env,
                 where, good_at=(), extra_headers=None, spares=()):
        self.id = pid
        self.label = label
        self.flavour = flavour          # openai | anthropic | gemini
        self.base = base
        self.default = default          # a sensible model to start from
        self.key_env = key_env          # environment variable to look in
        self.where = where              # where a human goes to get a key
        self.good_at = set(good_at)
        # Lighter siblings to fall back on.  A free allowance is counted per
        # model, so one of these usually still answers when the first has
        # spent its day's quota.
        self.spares = list(spares)
        self.extra_headers = extra_headers or {}

    # ------------------------------------------------------------ asking

    def ask(self, key, model, system, question, timeout=180, history=()):
        """`history` is the conversation before this question, oldest first,
        as {"role": "user"|"assistant", "text": ...}.  Every wire format here
        takes a list of turns, so a follow-up like "what about the second
        one" reaches the model with the thing it refers to still in view."""
        model = model or self.default
        try:
            fn = getattr(self, "_ask_" + self.flavour)
            return fn(key, model, system, question, timeout, history or ())
        except urllib.error.HTTPError as exc:
            return self._http_error(exc)
        except socket.timeout:
            return Answer(False, status=0, retry=True,
                          detail="%s took longer than %ds to answer."
                                 % (self.label, timeout))
        except urllib.error.URLError as exc:
            return Answer(False, status=0, retry=True,
                          detail="Could not reach %s: %s"
                                 % (self.label, getattr(exc, "reason", exc)))
        except Exception as exc:
            return Answer(False, status=0, retry=True,
                          detail="%s failed: %s" % (self.label, exc))

    def _http_error(self, exc):
        raw = ""
        try:
            raw = exc.read().decode("utf-8", "replace")[:2000]
        except Exception:
            pass
        detail, wait, daily = raw, 0.0, False
        try:                              # all three nest it the same way
            blob = json.loads(raw)
            err = blob.get("error", blob)
            if isinstance(err, dict):
                detail = err.get("message") or err.get("detail") or raw
                wait, daily = self._quota(err)
            elif isinstance(err, str):
                detail = err
        except Exception:
            pass
        detail = " ".join(str(detail).split())[:240]

        # A day's allowance being gone is a different thing from a burst
        # limit, and telling someone to try again shortly when the quota
        # resets tomorrow is worse than saying nothing.
        if exc.code == 429 and daily:
            return Answer(False, status=429, retry=True, wait=wait,
                          detail="%s has used up today's quota. Add another "
                                 "model, or enable billing on this key."
                                 % self.label)

        if exc.code in (401, 403):
            return Answer(False, status=exc.code, retry=True,
                          detail="%s did not accept the key%s"
                                 % (self.label, ": " + detail if detail else "."))
        if exc.code == 404:
            return Answer(False, status=404, retry=True,
                          detail="%s has no such model%s"
                                 % (self.label, ": " + detail if detail else "."))
        if exc.code in TRANSIENT:
            word = ("is rate limiting" if exc.code == 429 else
                    "is overloaded" if exc.code in (503, 529) else
                    "returned %d" % exc.code)
            return Answer(False, status=exc.code, retry=True, wait=wait,
                          detail="%s %s%s." % (
                              self.label, word,
                              ", back in %ds" % round(wait) if wait else ""))
        return Answer(False, status=exc.code, retry=exc.code >= 500,
                      detail="%s returned %d%s"
                             % (self.label, exc.code,
                                ": " + detail if detail else "."))

    @staticmethod
    def _quota(err):
        """How long to wait, and whether the limit was a daily one.

        Google says both in `details`; OpenAI-shaped errors say the second in
        the message.  Anything unrecognised just reads as an ordinary burst
        limit, which is the safe assumption."""
        wait = 0.0
        daily = False
        for det in err.get("details") or []:
            if not isinstance(det, dict):
                continue
            kind = det.get("@type", "")
            if "RetryInfo" in kind:
                try:
                    wait = float(str(det.get("retryDelay", "0")).rstrip("s"))
                except ValueError:
                    pass
            if "QuotaFailure" in kind:
                for v in det.get("violations") or []:
                    if "PerDay" in str(v.get("quotaId", "")):
                        daily = True
        text = str(err.get("message") or "").lower()
        if "per day" in text or "daily" in text or "quota exceeded" in text:
            daily = True
        return wait, daily

    def _post(self, url, body, headers, timeout):
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), method="POST",
            headers=dict({"Content-Type": "application/json"},
                         **dict(self.extra_headers, **headers)))
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    # -------------------------------------------------------- wire formats

    def _ask_openai(self, key, model, system, question, timeout, history=()):
        turns = [{"role": "system", "content": system}]
        for t in history:
            turns.append({"role": t["role"], "content": t["text"]})
        turns.append({"role": "user", "content": question})
        payload = self._post(
            self.base.rstrip("/") + "/chat/completions",
            {"model": model, "messages": turns},
            {"Authorization": "Bearer %s" % key} if key else {},
            timeout)
        try:
            choice = payload["choices"][0]
            text = (choice.get("message") or {}).get("content") or ""
            if isinstance(text, list):     # some gateways return parts
                text = "".join(p.get("text", "") for p in text)
        except (KeyError, IndexError):
            return Answer(False, status=200, retry=True,
                          detail="%s sent a reply with no answer in it."
                                 % self.label)
        return self._finish(text, model)

    def _ask_anthropic(self, key, model, system, question, timeout,
                       history=()):
        turns = [{"role": t["role"], "content": t["text"]} for t in history]
        turns.append({"role": "user", "content": question})
        payload = self._post(
            self.base.rstrip("/") + "/messages",
            {"model": model, "max_tokens": 4096, "system": system,
             "messages": turns},
            {"x-api-key": key, "anthropic-version": "2023-06-01"},
            timeout)
        text = "".join(b.get("text", "") for b in payload.get("content", [])
                       if b.get("type") == "text")
        return self._finish(text, model)

    def _ask_gemini(self, key, model, system, question, timeout, history=()):
        # Gemini calls the assistant's own turns "model" rather than
        # "assistant", and rejects the other spelling.
        turns = [{"role": "model" if t["role"] == "assistant" else "user",
                  "parts": [{"text": t["text"]}]} for t in history]
        turns.append({"role": "user", "parts": [{"text": question}]})
        payload = self._post(
            "%s/models/%s:generateContent"
            % (self.base.rstrip("/"), urllib.parse.quote(model)),
            {"systemInstruction": {"parts": [{"text": system}]},
             "contents": turns},
            {"x-goog-api-key": key}, timeout)
        try:
            parts = payload["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts)
        except (KeyError, IndexError):
            blocked = (payload.get("promptFeedback") or {}).get("blockReason")
            return Answer(False, status=200, retry=not blocked,
                          detail="Gemini returned no answer%s."
                                 % (" (%s)" % blocked if blocked else ""))
        return self._finish(text, model)

    def _finish(self, text, model):
        text = (text or "").strip()
        if not text:
            return Answer(False, status=200, retry=True,
                          detail="%s returned an empty answer." % self.label)
        return Answer(True, text=text, status=200)

    # ---------------------------------------------------------- discovery

    NOT_FOR_TEXT = ("-image", "-tts", "-audio", "-speech", "-vision-only",
                    "embed", "embedding", "moderation", "whisper", "tts-",
                    "dall-e", "imagen", "veo", "lyria", "music", "banana",
                    "computer-use", "robotics", "transcribe", "realtime",
                    "rerank", "guard", "-ocr", "video")

    @classmethod
    def _answers_questions(cls, name):
        low = name.lower()
        return not any(w in low for w in cls.NOT_FOR_TEXT)

    def models(self, key, timeout=30):
        """What this provider says it can run, newest-looking first.

        Model names move faster than any list that could be hard coded here,
        so ask.  An empty list just means the default stays on offer."""
        try:
            if self.flavour == "gemini":
                url = "%s/models?pageSize=200" % self.base.rstrip("/")
                req = urllib.request.Request(url, headers={"x-goog-api-key": key})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    blob = json.loads(r.read().decode("utf-8"))
                return sorted(
                    n for n in (
                        m["name"].replace("models/", "")
                        for m in blob.get("models", [])
                        if "generateContent" in
                        (m.get("supportedGenerationMethods") or []))
                    if self._answers_questions(n))

            headers = dict(self.extra_headers)
            if self.flavour == "anthropic":
                headers.update({"x-api-key": key,
                                "anthropic-version": "2023-06-01"})
            else:
                headers["Authorization"] = "Bearer %s" % key
            req = urllib.request.Request(
                self.base.rstrip("/") + "/models", headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                blob = json.loads(r.read().decode("utf-8"))
            items = blob.get("data") or blob.get("models") or []
            names = sorted({(m.get("id") or m.get("name") or "")
                            for m in items if isinstance(m, dict)})
            return [n for n in names if n and self._answers_questions(n)]
        except Exception:
            return []


# Everything below is reachable with an API key and nothing else.  good_at is
# used only to break ties when the assistant is left on Auto; it is a
# preference, not a claim that a model cannot do the other things.
PROVIDERS = {
    "openai": Provider(
        "openai", "OpenAI", "openai", "https://api.openai.com/v1",
        "gpt-5.6-sol", "OPENAI_API_KEY", "platform.openai.com/api-keys",
        good_at=("reasoning", "code", "writing")),
    "anthropic": Provider(
        "anthropic", "Claude", "anthropic", "https://api.anthropic.com/v1",
        "claude-opus-5", "ANTHROPIC_API_KEY",
        "console.anthropic.com/settings/keys",
        good_at=("code", "writing", "long")),
    "gemini": Provider(
        "gemini", "Gemini", "gemini",
        "https://generativelanguage.googleapis.com/v1beta",
        "gemini-3.8-flash", "GEMINI_API_KEY", "aistudio.google.com/apikey",
        good_at=("long", "summary", "reasoning"),
        spares=("gemini-flash-latest", "gemini-flash-lite-latest",
                "gemini-3.5-flash-lite")),
    "xai": Provider(
        "xai", "Grok", "openai", "https://api.x.ai/v1",
        "grok-4", "XAI_API_KEY", "console.x.ai",
        good_at=("reasoning",)),
    "deepseek": Provider(
        "deepseek", "DeepSeek", "openai", "https://api.deepseek.com/v1",
        "deepseek-chat", "DEEPSEEK_API_KEY", "platform.deepseek.com",
        good_at=("code", "reasoning")),
    "mistral": Provider(
        "mistral", "Mistral", "openai", "https://api.mistral.ai/v1",
        "mistral-large-latest", "MISTRAL_API_KEY", "console.mistral.ai",
        good_at=("summary",)),
    "groq": Provider(
        "groq", "Groq", "openai", "https://api.groq.com/openai/v1",
        "llama-3.3-70b-versatile", "GROQ_API_KEY", "console.groq.com/keys",
        good_at=("summary",)),
    "openrouter": Provider(
        "openrouter", "OpenRouter", "openai", "https://openrouter.ai/api/v1",
        "openai/gpt-5.6-sol", "OPENROUTER_API_KEY", "openrouter.ai/keys",
        good_at=("reasoning", "code", "writing", "summary", "long")),
    "perplexity": Provider(
        "perplexity", "Perplexity", "openai", "https://api.perplexity.ai",
        "sonar-pro", "PERPLEXITY_API_KEY", "perplexity.ai/settings/api",
        good_at=("reasoning",)),
    "cohere": Provider(
        "cohere", "Cohere", "openai",
        "https://api.cohere.ai/compatibility/v1",
        "command-a-03-2025", "COHERE_API_KEY", "dashboard.cohere.com/api-keys",
        good_at=("summary", "long")),
    "together": Provider(
        "together", "Together AI", "openai", "https://api.together.xyz/v1",
        "deepseek-ai/DeepSeek-V3", "TOGETHER_API_KEY", "api.together.ai",
        good_at=("code", "summary")),
    "fireworks": Provider(
        "fireworks", "Fireworks", "openai",
        "https://api.fireworks.ai/inference/v1",
        "accounts/fireworks/models/deepseek-v3", "FIREWORKS_API_KEY",
        "fireworks.ai/account/api-keys", good_at=("code", "summary")),
    "cerebras": Provider(
        "cerebras", "Cerebras", "openai", "https://api.cerebras.ai/v1",
        "llama-3.3-70b", "CEREBRAS_API_KEY", "cloud.cerebras.ai",
        good_at=("summary",)),
    "nvidia": Provider(
        "nvidia", "NVIDIA NIM", "openai",
        "https://integrate.api.nvidia.com/v1",
        "deepseek-ai/deepseek-v3", "NVIDIA_API_KEY", "build.nvidia.com",
        good_at=("code",)),
    "sambanova": Provider(
        "sambanova", "SambaNova", "openai", "https://api.sambanova.ai/v1",
        "Meta-Llama-3.3-70B-Instruct", "SAMBANOVA_API_KEY",
        "cloud.sambanova.ai", good_at=("summary",)),
    "moonshot": Provider(
        "moonshot", "Moonshot (Kimi)", "openai",
        "https://api.moonshot.ai/v1",
        "kimi-k2-0905-preview", "MOONSHOT_API_KEY", "platform.moonshot.ai",
        good_at=("code", "long")),
    "zhipu": Provider(
        "zhipu", "Z.ai (GLM)", "openai",
        "https://api.z.ai/api/paas/v4",
        "glm-4.6", "ZHIPU_API_KEY", "z.ai/manage-apikey/apikey-list",
        good_at=("code", "reasoning")),
    "qwen": Provider(
        "qwen", "Qwen", "openai",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "qwen-max", "DASHSCOPE_API_KEY", "bailian.console.alibabacloud.com",
        good_at=("code", "long")),
    "huggingface": Provider(
        "huggingface", "Hugging Face", "openai",
        "https://router.huggingface.co/v1",
        "deepseek-ai/DeepSeek-V3-0324", "HF_TOKEN",
        "huggingface.co/settings/tokens", good_at=("summary",)),
    "azure": Provider(
        # Every Azure deployment has its own hostname, so this one only works
        # once ai.endpoints.azure in config.json points at yours.
        "azure", "Azure OpenAI", "openai",
        "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
        "gpt-5.6-sol", "AZURE_OPENAI_API_KEY", "portal.azure.com",
        good_at=("reasoning", "code", "writing")),
}

ORDER = ["openai", "anthropic", "gemini", "xai", "deepseek", "mistral",
         "groq", "openrouter", "perplexity", "cohere", "together",
         "fireworks", "cerebras", "nvidia", "sambanova", "moonshot",
         "zhipu", "qwen", "huggingface", "azure"]


def load_keys(secrets_path=None, environ=None):
    """Every provider that has a key, and the key.

    The environment first, then the secrets file, so a deployment can pin a
    key that nothing else can quietly replace.  Both the server and the
    collector read keys this way, so they always agree on what is available.
    """
    environ = os.environ if environ is None else environ
    stored = {}
    if secrets_path and os.path.exists(secrets_path):
        try:
            with open(secrets_path) as fh:
                blob = json.load(fh)
            stored = dict(blob.get("keys") or {})
            # The single-provider layout this grew out of.
            if blob.get("gemini_api_key") and "gemini" not in stored:
                stored["gemini"] = blob["gemini_api_key"]
        except Exception:
            stored = {}

    keys = {}
    for pid, p in PROVIDERS.items():
        key = ((environ.get(p.key_env) or "").strip()
               or str(stored.get(pid) or "").strip())
        if key:
            keys[pid] = key
    return keys


def configure(endpoints):
    """Point a provider somewhere other than its own API.

    For a company gateway, a regional endpoint, or anything else that speaks
    the same wire format from a different address."""
    for pid, base in (endpoints or {}).items():
        if pid in PROVIDERS and base:
            PROVIDERS[pid].base = str(base).rstrip("/")


# What kind of question this is, and who to ask first.  A question about a
# rejected hunk is a code question; "what should I say back" is a writing
# question; "how many landed in net-next" is a lookup over a long digest.
ZONES = {
    "code":      ["anthropic", "deepseek", "openai", "gemini", "openrouter"],
    "writing":   ["anthropic", "openai", "gemini", "openrouter"],
    "reasoning": ["openai", "anthropic", "gemini", "xai", "openrouter"],
    "summary":   ["gemini", "openai", "groq", "anthropic", "openrouter"],
    "long":      ["gemini", "anthropic", "openai", "openrouter"],
}

ZONE_WORDS = [
    ("code", ("diff", "hunk", "compile", "build", "warning", "kbuild",
              "sparse", "checkpatch", "coccinelle", "bisect", "oops",
              "kasan", "syzkaller", "code", "function", "struct", "macro",
              "backport", "conflict", "rebase")),
    ("writing", ("reply", "respond", "answer", "word", "draft",
                 "cover letter", "changelog", "commit message", "phrase",
                 "say", "write", "email", "politely", "thank")),
    ("summary", ("how many", "list", "count", "which", "summarise",
                 "summarize", "breakdown", "total", "table", "show me")),
    ("reasoning", ("why", "should i", "strategy", "plan", "next", "priorit",
                   "decide", "compare", "worth", "best", "stuck", "risk")),
]


def zone_of(question):
    """A rough read of what is being asked.  Wrong sometimes, and that is
    survivable: it only sets who gets asked first."""
    q = (question or "").lower()
    for zone, words in ZONE_WORDS:
        if any(w in q for w in words):
            return zone
    return "summary"


def route(question, available, pinned=None):
    """The order to try providers in.

    `available` is the ids that actually have a key.  `pinned` is the user
    choosing a provider by hand, which puts it first but does not stop the
    others being used when it falls over."""
    zone = zone_of(question)
    order = []
    if pinned and pinned in available:
        order.append(pinned)
    for pid in ZONES.get(zone, []):
        if pid in available and pid not in order:
            order.append(pid)
    for pid in ORDER:                      # anything left, in a stable order
        if pid in available and pid not in order:
            order.append(pid)
    return zone, order


def ask(system, prompt, keys, models=None, pinned=None, timeout=180,
        log=None, topic=None, budget=150, history=()):
    """Ask the best-placed provider, and keep going when one falls over.

    `prompt` is everything the model gets, which in practice is a large blob
    of collected data with the question at the end.  `topic` is the question
    on its own, and it is what decides the routing: run the classifier over
    the whole prompt and every question comes out as a code question, because
    the data mentions structs and rebases.

    Returns (Answer, trail).  The trail says who was tried and what happened,
    so the page can show "Gemini was overloaded, Claude answered" rather than
    silently producing an answer in a different voice."""
    models = models or {}
    available = [p for p in ORDER if keys.get(p)]
    if not available:
        return Answer(False, detail="No API key for any model yet."), []

    zone, order = route(topic if topic is not None else prompt,
                        available, pinned)
    trail = []
    # Walking several models, each with its own timeout and its own retry,
    # can add up to minutes.  Nobody waits that long, and the browser gives
    # up first and says only "failed to fetch".  One deadline covers the
    # whole attempt.
    deadline = time.time() + budget
    ran_out = False
    for pid in order:
        p = PROVIDERS[pid]
        # A free allowance is usually counted per model, not per key, so a
        # sibling model on the same provider is worth trying before writing
        # the whole provider off.  A model the caller pinned is tried first.
        chosen = models.get(pid) or p.default
        line = [chosen] + [m for m in p.spares if m != chosen]
        spent = False           # this model's own allowance is gone for today

        for model in line:
            if time.time() >= deadline:
                ran_out = True
                break
            # "Overloaded" and "rate limited" often mean "ask again shortly",
            # and when there is only one key configured there is nobody else
            # to ask.  One short wait costs little and rescues the common case.
            for attempt in range(RETRIES):
                if attempt:
                    time.sleep(BACKOFF * attempt)
                left = deadline - time.time()
                if left <= 1:
                    ran_out = True
                    break
                started = time.time()
                answer = p.ask(keys.get(pid, ""), model, system, prompt,
                               min(timeout, int(left)), history=history)
                took = round(time.time() - started, 1)
                trail.append({"provider": pid, "label": p.label, "model": model,
                              "ok": answer.ok, "status": answer.status,
                              "attempt": attempt + 1,
                              "detail": "" if answer.ok else answer.detail,
                              "seconds": took})
                if log:
                    log("ai %s/%s %s in %.1fs%s"
                        % (pid, model, "ok" if answer.ok else "failed", took,
                           "" if answer.ok else " (%s)" % answer.detail))
                if answer.ok:
                    answer.provider, answer.model, answer.zone = pid, model, zone
                    return answer, trail
                if not answer.retry:
                    answer.zone = zone
                    return answer, trail
                spent = answer.status in (404, 429) and (
                    getattr(answer, "wait", 0) > BACKOFF * RETRIES
                    or "quota" in answer.detail.lower())
                if answer.status not in BUSY:
                    break           # a different provider is the better bet
                if getattr(answer, "wait", 0) > BACKOFF * RETRIES:
                    break           # it told us it needs longer than we wait

            if ran_out or not spent:
                break               # the provider itself is the problem
        if ran_out:
            break

    last = trail[-1]["detail"] if trail else "nothing to try"
    if ran_out:
        beaten = Answer(False, detail="Gave up after %ds. The models that "
                                      "answered were too slow, and the rest "
                                      "were not reachable." % budget)
    else:
        beaten = Answer(False, detail="Every model failed. Last was %s" % last)
    beaten.zone = zone
    return beaten, trail
