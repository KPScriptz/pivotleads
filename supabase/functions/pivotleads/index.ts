// supabase/functions/pivotleads/index.ts
// Supabase Edge Function (Deno). Deploy: supabase functions deploy pivotleads
//
// ⚠️ WHAT THIS DOES — AND WHAT IT DELIBERATELY DOES NOT DO
// It does NOT scrape "who liked/commented on a LinkedIn post." That engagement
// data is not in any search index: it lives behind LinkedIn's auth wall, and it
// does not appear on the engagers' public /in/ profile pages. A query like
// `site:linkedin.com/in/ "<activity-id>"` therefore returns essentially nothing.
//
// Instead this uses the Google Custom Search JSON API to DISCOVER real
// ICP-matching decision-makers by title + company + US geography — searching the
// PUBLIC web index (your CSE must be set to "Search the entire web"), so it —
// compliant, no LinkedIn login or session cookie, no ToS violation — then filters
// and enriches the results with Claude and inserts them into my_origami_leads.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the Supabase
// runtime — you do NOT set those. You DO set the search + LLM secrets:
//   supabase secrets set SERPER_API_KEY=... ANTHROPIC_API_KEY=...
// SECURITY: keys live in secrets, never in source. Rotate the Serper key if it leaks.
// Serper.dev returns Google results over a simple POST API — no CSE "cx", no Google
// Cloud project, no billing — so it sidesteps the Custom Search 403 entirely.
const SERPER_API_KEY = Deno.env.get("SERPER_API_KEY");
const APOLLO_API_KEY = Deno.env.get("APOLLO_API_KEY");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Derive a searchable company name from whatever URL was pasted:
// linkedin.com/company/<slug>, linkedin.com/posts/<author>_activity-..., a /in/
// profile, or a plain company website.
function companyFromLink(link: string): string {
  try {
    const u = new URL(link.trim());
    const path = u.pathname;
    let m = path.match(/\/company\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]).replace(/-/g, " ");
    m = path.match(/\/posts\/([^_]+)_/); // author slug on a post URL
    if (m) {
      return decodeURIComponent(m[1]).replace(/-\d.*$/, "").replace(/-/g, " ");
    }
    m = path.match(/\/in\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]).replace(/-\d.*$/, "").replace(/-/g, " ");
    return u.hostname.replace(/^www\./, "").split(".")[0]; // plain website
  } catch {
    return link.trim();
  }
}

async function serperSearch(query: string) {
  // Serper.dev — Google search results over a simple POST API (no CSE, no billing).
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10, gl: "us" }),
  });
  if (!res.ok) {
    throw new Error(`Serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.organic ?? []).map(
    (r: { title?: string; snippet?: string; link?: string }) => ({
      title: r.title ?? "",
      snippet: r.snippet ?? "",
      link: r.link ?? "",
    }),
  );
}

// Placeholder enrichment — a pattern guess, NOT a verified deliverable address.
// Swap in a real verification provider (Hunter, Apollo) before any outreach.
function guessEmail(name: string, company: string): string {
  const parts = (name ?? "").toLowerCase().trim().split(/\s+/);
  const domain = (company ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
  if (parts.length < 2) return "";
  return `${parts[0]}.${parts[parts.length - 1]}@${domain}`;
}

// Best-effort full name from an email local part ("brianna.rohrhoff" → "Brianna Rohrhoff").
function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] || "").replace(/[0-9]+$/, "");
  if (!local.includes(".")) return "";
  return local.split(/[._-]+/).filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

// Cheap deliverability check: does the email's DOMAIN accept mail (MX records)?
// Uses DNS-over-HTTPS (Google) because Deno.resolveDns isn't available in the edge
// runtime. This validates the DOMAIN, not the individual mailbox — the local part is
// still a pattern guess — so a pass is "medium" confidence, a fail is "low".
const mxCache = new Map<string, boolean>();
async function domainHasMx(domain: string): Promise<boolean> {
  const d = (domain ?? "").toLowerCase().trim();
  if (!d) return false;
  if (mxCache.has(d)) return mxCache.get(d)!;
  let ok = false;
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=MX`, {
      headers: { accept: "application/dns-json" },
    });
    if (res.ok) {
      const data = await res.json();
      // Status 0 = NOERROR; MX answers have type 15.
      ok = data.Status === 0 && Array.isArray(data.Answer) &&
        data.Answer.some((a: { type?: number }) => a.type === 15);
    }
  } catch (_e) {
    ok = false; // transient DNS/network error → don't over-claim deliverability
  }
  mxCache.set(d, ok);
  return ok;
}

// ---------------------------------------------------------------------------
// Provider abstraction. A LeadProvider turns a request into normalized leads.
// Everything downstream (dedup → MX-verify → store) is provider-agnostic, so a new
// source (Apollo, Hunter, People Data Labs, CSV upload) plugs in by implementing
// this one interface. Providers that return REAL emails set `email`; discovery
// providers (web search) leave it blank and the pipeline guesses + MX-checks.
// ---------------------------------------------------------------------------
interface ProviderLead {
  person_name: string;
  decision_maker_title: string;
  company_name: string;
  profile_url: string; // public LinkedIn /in/ URL
  fit_score: number; // 0–100
  buying_signal: string;
  email?: string; // real, provider-supplied address (Apollo/Hunter); blank for search providers
}

interface ProviderInput {
  targetLinks: string[];
  icpRules: string;
  mode?: "target" | "discover";
  rows?: ProviderLead[];
  enrichCap?: number;
  apolloFilters?: { sizes?: string[]; industries?: string[] };
}

interface LeadProvider {
  name: string;
  fetchLeads(input: ProviderInput): Promise<{ leads: ProviderLead[]; meta?: Record<string, unknown> }>;
}

// Serper's free tier is generous; this issues ONE query per company, hard-capped so a
// 4×/day schedule stays well within limits no matter how many links get posted.
const MAX_QUERIES_PER_RUN = 25;

// Serper provider: DISCOVER ICP people via the public web index, then CLASSIFY with Claude.
const serperProvider: LeadProvider = {
  name: "serper",
  async fetchLeads({ targetLinks, icpRules, mode }) {
    if (!SERPER_API_KEY || !ANTHROPIC_API_KEY) {
      throw new Error("serper provider requires SERPER_API_KEY and ANTHROPIC_API_KEY");
    }
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY! });

    // 1) BUILD SEARCH QUERIES.
    //  - target mode: one query per pasted company.
    //  - discover mode: an AI planner expands the ICP into varied people-search queries,
    //    so you GENERATE leads from a description instead of a hand-fed company list.
    const roleTerms = '("Director" OR "Head" OR "VP" OR "Producer" OR "Creative" OR "Manager")';
    let queries: { q: string; company: string }[] = [];
    if (mode === "discover") {
      const planSchema = {
        type: "object",
        additionalProperties: false,
        properties: { queries: { type: "array", items: { type: "string" } } },
        required: ["queries"],
      };
      const planPrompt = `Turn this Ideal Customer Profile into 6 Google search queries that surface matching US decision-makers' PUBLIC LinkedIn profiles.

ICP: ${icpRules}

Rules for EACH query:
- MUST start with: site:linkedin.com/in
- Include boolean role/title terms and industry keywords drawn from the ICP, plus "United States".
- Vary the titles and the industry angle across the 6 so together they cast a wide net.
Return JSON only: {"queries": ["...", "..."]}`;
      try {
        const pm = await anthropic.messages.create({
          model: "claude-opus-4-8",
          max_tokens: 700,
          output_config: { effort: "low", format: { type: "json_schema", schema: planSchema } },
          messages: [{ role: "user", content: planPrompt }],
        });
        const ptb = pm.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
        const parsed = JSON.parse(ptb?.text ?? "{}");
        if (Array.isArray(parsed.queries)) queries = parsed.queries.map((q: unknown) => ({ q: String(q), company: "" }));
      } catch (e) {
        console.error("discover planner failed:", String(e));
      }
    } else {
      queries = targetLinks.map((link) => {
        const company = companyFromLink(link);
        return { q: `site:linkedin.com/in ${roleTerms} "${company}" (experiential OR event OR activation OR immersive OR fan) United States`, company };
      });
    }
    queries = queries.slice(0, MAX_QUERIES_PER_RUN);

    // 2) SEARCH the public index.
    const results: { title: string; snippet: string; link: string; company: string }[] = [];
    for (const { q, company } of queries) {
      try {
        const hits = await serperSearch(q);
        for (const h of hits) results.push({ ...h, company });
      } catch (e) {
        console.error(`search failed:`, String(e));
      }
    }
    if (results.length === 0) return { leads: [], meta: { queriesUsed: queries.length, mode: mode ?? "target" } };

    // 3) FILTER + enrich with Claude → schema-validated JSON.
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        leads: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              person_name: { type: "string" },
              decision_maker_title: { type: "string" },
              company_name: { type: "string" },
              profile_url: { type: "string" },
              fit_score: { type: "integer" },
              buying_signal: { type: "string" },
            },
            required: ["person_name", "decision_maker_title", "company_name", "profile_url", "fit_score", "buying_signal"],
          },
        },
      },
      required: ["leads"],
    };

    const payload = results.map((r) => ({
      title: r.title,
      snippet: r.snippet,
      profile_url: r.link,
      author_company: r.company,
    }));

    const prompt = `You are screening public LinkedIn search results against a STRICT Ideal Customer Profile for an experiential brand-activation product. "author_company" is the company each result was surfaced under (context only).

INCLUDE ONLY people who clearly match one of these roles:
  • Agency-side: Producer / Executive Producer, Creative Director / Executive Creative Director, or Experiential Marketing leader (Head / Director / VP of Experiential).
  • Brand-side (consumer brands): Event Marketing Manager, Director of Events, or Head of Experiential.

APPLY ALL THREE HARD FILTERS — reject the result on ANY failure:
1. ROLE MATCH: Title must match the INCLUDE list. If the role is unclear from the title/snippet, reject.
2. GEOGRAPHY: United States only. Reject anyone the snippet places outside the US. If location is unknown, keep only when the role match is otherwise strong.
3. OFF-TARGET ROLES: Immediately reject software engineers/developers, recruiters/talent, sales/account reps, administrative/executive assistants, students, interns, and anything not on the INCLUDE list.

Additional ICP context from the user:
${icpRules}

RESULTS (JSON):
${JSON.stringify(payload, null, 2)}

For each result that passes ALL THREE filters, output one lead:
- person_name and decision_maker_title: verbatim from the title/snippet — never invent.
- company_name: the person's CURRENT employer (from the title/snippet).
- profile_url: the result's linkedin.com/in link.
- fit_score: 0-100 by strength of ICP match.
- buying_signal: one concise sentence on why they fit.
Return JSON only. If nothing passes, return {"leads": []}.`;

    const msg = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
    let raw: Record<string, unknown>[] = [];
    try {
      const parsed = JSON.parse(textBlock?.text ?? "{}");
      if (Array.isArray(parsed.leads)) raw = parsed.leads;
    } catch (e) {
      console.error("failed to parse model output:", String(e));
    }

    // Web-search discovery has no email — leave it blank so the pipeline guesses + MX-checks.
    const leads: ProviderLead[] = raw.map((l) => ({
      person_name: String(l.person_name ?? ""),
      decision_maker_title: String(l.decision_maker_title ?? ""),
      company_name: String(l.company_name ?? ""),
      profile_url: String(l.profile_url ?? ""),
      fit_score: Math.max(0, Math.min(100, Number(l.fit_score) || 0)),
      buying_signal: String(l.buying_signal ?? ""),
      email: "",
    }));
    return { leads, meta: { queriesUsed: queries.length, mode: mode ?? "target" } };
  },
};

// Plug-in point for REAL data providers (verified emails). Implement fetchLeads()
// against the provider's API and set `email` on each ProviderLead — dedup, MX verify,
// and storage all work unchanged. Scaffold for Apollo:
const apolloProvider: LeadProvider = {
  name: "apollo",
  async fetchLeads({ icpRules, enrichCap, apolloFilters }) {
    if (!APOLLO_API_KEY) throw new Error("apollo provider needs APOLLO_API_KEY");
    const SEARCH_PER_PAGE = 25; // free search
    const MAX_ENRICH = Math.max(1, Math.min(25, enrichCap ?? 10)); // HARD credit cap per run
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": APOLLO_API_KEY };

    // 1) Plan Apollo title filters from the ICP (falls back to sensible defaults).
    let titles: string[] = [];
    if (ANTHROPIC_API_KEY) {
      try {
        const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
        const schema = { type: "object", additionalProperties: false, properties: { person_titles: { type: "array", items: { type: "string" } } }, required: ["person_titles"] };
        const pm = await anthropic.messages.create({
          model: "claude-opus-4-8", max_tokens: 400,
          output_config: { effort: "low", format: { type: "json_schema", schema } },
          messages: [{ role: "user", content: `Extract 6-8 specific job titles to search on Apollo for this ICP. ICP: ${icpRules}\nReturn JSON {"person_titles":[...]}` }],
        });
        const tb = pm.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
        const parsed = JSON.parse(tb?.text ?? "{}");
        if (Array.isArray(parsed.person_titles)) titles = parsed.person_titles.map(String).slice(0, 10);
      } catch (e) {
        console.error("apollo planner failed:", String(e));
      }
    }
    if (titles.length === 0) titles = ["Director of Events", "Head of Experiential", "Event Marketing Manager", "VP Marketing"];

    // 2) SEARCH (free — no credits). Apply firmographic filters at the source.
    const searchBody: Record<string, unknown> = { person_titles: titles, person_locations: ["United States"], page: 1, per_page: SEARCH_PER_PAGE };
    const sizes = (apolloFilters?.sizes ?? []).filter(Boolean);
    const industries = (apolloFilters?.industries ?? []).filter(Boolean);
    if (sizes.length) searchBody.organization_num_employees_ranges = sizes; // e.g. ["51,200","201,500"]
    if (industries.length) searchBody.q_organization_keyword_tags = industries; // e.g. ["marketing and advertising"]
    const sRes = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", { method: "POST", headers, body: JSON.stringify(searchBody) });
    if (!sRes.ok) throw new Error(`Apollo search ${sRes.status}: ${(await sRes.text()).slice(0, 200)}`);
    const sData = await sRes.json();
    const candidates = (sData.people ?? []).filter((p: { has_email?: boolean; id?: string }) => p.has_email && p.id).slice(0, MAX_ENRICH);

    // 3) ENRICH each candidate (1 credit each, hard-capped at MAX_ENRICH, NO retries).
    const leads: ProviderLead[] = [];
    for (const c of candidates) {
      try {
        const mRes = await fetch("https://api.apollo.io/api/v1/people/match", { method: "POST", headers, body: JSON.stringify({ id: c.id }) });
        if (!mRes.ok) continue;
        const p = (await mRes.json()).person ?? {};
        const rawEmail = String(p.email ?? "");
        if (!rawEmail || rawEmail.includes("email_not_unlocked") || p.email_status === "unavailable") continue;
        leads.push({
          person_name: nameFromEmail(rawEmail) || p.name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || String(c.first_name ?? ""),
          decision_maker_title: p.title || c.title || "",
          company_name: (p.organization?.name) || (c.organization?.name) || "",
          profile_url: p.linkedin_url || "",
          fit_score: 80,
          buying_signal: `Apollo verified contact — ${p.title || "ICP role"} at ${(p.organization?.name) || "target company"} (email ${p.email_status || "found"}).`,
          email: rawEmail,
        });
      } catch (e) {
        console.error("apollo match failed:", String(e));
      }
    }
    return { leads, meta: { source: "apollo", searched: (sData.people ?? []).length, enriched: leads.length, creditsCap: MAX_ENRICH } };
  },
};

// CSV upload provider — the user brings their own list; rows are normalized on the
// client and passed straight into the shared dedup → MX-verify → store spine.
const csvProvider: LeadProvider = {
  name: "csv",
  fetchLeads({ rows }) {
    const list = Array.isArray(rows) ? rows : [];
    return Promise.resolve({
      leads: list.filter((r) => r && (r.person_name || r.email)),
      meta: { source: "csv-upload", received: list.length },
    });
  },
};

const PROVIDERS: Record<string, LeadProvider> = {
  serper: serperProvider,
  apollo: apolloProvider,
  csv: csvProvider,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // The spine only needs Supabase (auto-injected); each provider validates its own keys.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase)." }, 500);
  }

  let body: { targetLinks?: unknown; icpRules?: unknown; provider?: unknown; action?: unknown; lead?: Record<string, unknown>; senderContext?: unknown; mode?: unknown; rows?: unknown; enrichCap?: unknown; apolloFilters?: { sizes?: string[]; industries?: string[] }; prompt?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // --- AI Outreach Composer: draft a personalized message the USER sends manually.
  // Compliant networking aid — it writes copy, it never contacts anyone.
  if (body.action === "compose") {
    if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);
    const lead = (body.lead ?? {}) as Record<string, unknown>;
    const senderContext = typeof body.senderContext === "string" && body.senderContext.trim()
      ? body.senderContext.trim()
      : "an experiential photo/AR brand-activation product for live events and brand activations";
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { connection_note: { type: "string" }, email_opener: { type: "string" } },
      required: ["connection_note", "email_opener"],
    };
    const prompt = `Draft outreach for a B2B partnership/networking first-touch. The user SENDS IT MANUALLY — never automate contact.

PROSPECT
- Name: ${String(lead.person_name ?? "")}
- Title: ${String(lead.decision_maker_title ?? "")}
- Company: ${String(lead.company_name ?? "")}
- Why they fit: ${String(lead.buying_signal ?? "")}

THE SENDER offers: ${senderContext}

Write:
- connection_note: a LinkedIn connection-request note, MAX 280 characters, warm and specific (reference their role/company), ONE light reason to connect, no hard pitch, no emojis, no "hope this finds you well".
- email_opener: a 2-3 sentence cold email opener — specific, human, ends with a low-friction ask (a quick 15-min chat). No filler, no buzzwords.
Return JSON only.`;
    try {
      const msg = await anthropic.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 800,
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      });
      const tb = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
      const parsed = JSON.parse(tb?.text ?? "{}");
      return json({ connection_note: String(parsed.connection_note ?? ""), email_opener: String(parsed.email_opener ?? "") });
    } catch (e) {
      return json({ error: `compose failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  // --- Subject-line generator: 3 tailored, high-open cold-email subject lines. ---
  if (body.action === "subjects") {
    if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);
    const lead = (body.lead ?? {}) as Record<string, unknown>;
    const senderContext = typeof body.senderContext === "string" && body.senderContext.trim()
      ? body.senderContext.trim()
      : "an experiential photo/AR brand-activation product for live events";
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { subjects: { type: "array", items: { type: "string" } } },
      required: ["subjects"],
    };
    const prompt = `Write 3 cold-email SUBJECT LINES for this prospect. Rules: each under 55 characters; specific and human; no clickbait, no fake "Re:", no ALL CAPS, no emojis. Vary the angle across the three (1 curiosity, 1 relevance to their role/company, 1 benefit).

PROSPECT: ${String(lead.person_name ?? "")}, ${String(lead.decision_maker_title ?? "")} at ${String(lead.company_name ?? "")}.
Why they fit: ${String(lead.buying_signal ?? "")}
SENDER offers: ${senderContext}

Return JSON only: {"subjects":["...","...","..."]}`;
    try {
      const msg = await anthropic.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 400,
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      });
      const tb = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
      const parsed = JSON.parse(tb?.text ?? "{}");
      const subjects = Array.isArray(parsed.subjects) ? parsed.subjects.map(String).slice(0, 3) : [];
      return json({ subjects });
    } catch (e) {
      return json({ error: `subjects failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  // --- AI copilot: freeform "ask Claude to work on this campaign" from the command bar.
  // Answers the operator's question AND may map it to ONE in-app action the client runs.
  if (body.action === "assist") {
    if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json({ error: "Empty prompt" }, 400);
    const ctx = (body.context ?? {}) as Record<string, unknown>;
    const senderContext = typeof body.senderContext === "string" && body.senderContext.trim() ? body.senderContext.trim() : "";
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const ACTIONS = ["none", "discover", "export_csv", "fast_queue", "goto_overview", "goto_people", "goto_template", "goto_review", "goto_settings"];
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { reply: { type: "string" }, action: { type: "string", enum: ACTIONS } },
      required: ["reply", "action"],
    };
    const system = `You are Claude, the AI copilot embedded in "Pivot Leads" — a B2B lead-generation campaign workspace. You help the operator source, qualify, and MANUALLY reach out to decision-makers (every message is sent by hand — never automate or imply automated contact). Be concise, practical, and specific; answer in 1-4 sentences. When the request maps to one of the app's actions, set "action" so the app performs it; otherwise use "none".
Actions: discover = run ICP-based lead discovery; export_csv = download the current leads; fast_queue = open the keyboard-driven outreach focus mode; goto_overview / goto_people / goto_template / goto_review / goto_settings = switch to that tab.${senderContext ? "\nThe operator's offering: " + senderContext : ""}`;
    const userMsg = `CAMPAIGN CONTEXT (JSON): ${JSON.stringify(ctx)}\n\nOPERATOR REQUEST: ${prompt}`;
    try {
      const msg = await anthropic.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 700,
        system,
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: userMsg }],
      });
      const tb = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
      const parsed = JSON.parse(tb?.text ?? "{}");
      const action = ACTIONS.includes(parsed.action) ? parsed.action : "none";
      return json({ reply: String(parsed.reply ?? ""), action });
    } catch (e) {
      return json({ error: `assist failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  const targetLinks = Array.isArray(body.targetLinks)
    ? (body.targetLinks as string[]).filter(Boolean)
    : [];
  const icpRules =
    typeof body.icpRules === "string" && body.icpRules.trim()
      ? body.icpRules.trim()
      : "Agency-side Producers, Creative Directors, and Experiential Marketing leaders; or brand-side (consumer brands) Event Marketing Managers, Directors of Events, and Heads of Experiential. US only.";
  const providerName =
    typeof body.provider === "string" && body.provider.trim() ? body.provider.trim().toLowerCase() : "serper";
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return json({ error: `Unknown provider "${providerName}". Available: ${Object.keys(PROVIDERS).join(", ")}.` }, 400);
  }
  const mode = body.mode === "discover" ? ("discover" as const) : ("target" as const);
  const csvRows = Array.isArray(body.rows) ? (body.rows as ProviderLead[]) : [];
  if (providerName === "serper" && mode === "target" && targetLinks.length === 0) {
    return json({ error: "targetLinks is empty (or use Discover mode to generate leads from the ICP)." }, 400);
  }
  if (providerName === "csv" && csvRows.length === 0) {
    return json({ error: "csv provider needs a non-empty rows array." }, 400);
  }

  // 1) SOURCE leads from the selected provider (everything below is provider-agnostic).
  let providerLeads: ProviderLead[] = [];
  let meta: Record<string, unknown> | undefined;
  try {
    const out = await provider.fetchLeads({ targetLinks, icpRules, mode, rows: csvRows, enrichCap: typeof body.enrichCap === "number" ? body.enrichCap : undefined, apolloFilters: body.apolloFilters });
    providerLeads = out.leads;
    meta = out.meta;
  } catch (e) {
    return json({ error: `Provider "${providerName}" failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }

  if (providerLeads.length === 0) {
    return json({ insertedCount: 0, leads: [], provider: providerName, ...(meta ?? {}), note: "Provider returned no leads." });
  }

  // 2) NORMALIZE → rows. Use the provider's REAL email when present; otherwise guess.
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
  const rows = providerLeads.map((l) => {
    const url = (l.profile_url ?? "").trim();
    const email = l.email && l.email.trim() ? l.email.trim() : guessEmail(l.person_name, l.company_name);
    return {
      person_name: l.person_name,
      company_name: l.company_name,
      // Store null (not "") when there's no profile URL, so the website_url unique index
      // doesn't collide across URL-less leads (e.g. Apollo contacts) — nulls are distinct.
      linkedin_url: url || null,
      website_url: url || null,
      fit_score: Math.max(0, Math.min(100, Number(l.fit_score) || 0)),
      buying_signal: l.buying_signal,
      decision_maker_title: l.decision_maker_title,
      verified_email: email,
      email_confidence: "",
      created_at: new Date().toISOString(),
    };
  });

  // Dedup key: the profile URL when present, else the email. Applies within this batch
  // AND against the DB, so URL-less providers (Apollo) still dedup cleanly by email.
  const keyOf = (r: { website_url: string | null; verified_email: string }) =>
    r.website_url || (r.verified_email ? `email:${r.verified_email.toLowerCase()}` : "");
  const seenInBatch = new Set<string>();
  const batch = rows.filter((r) => {
    const k = keyOf(r);
    if (!k) return true;
    if (seenInBatch.has(k)) return false;
    seenInBatch.add(k);
    return true;
  });

  // Dedup against rows already in the DB (by URL and by email).
  const urls = batch.map((r) => r.website_url).filter(Boolean) as string[];
  const emails = batch.map((r) => r.verified_email).filter(Boolean);
  const existing = new Set<string>();
  if (urls.length) {
    const { data } = await supabase.from("my_origami_leads").select("website_url").in("website_url", urls);
    (data ?? []).forEach((d: { website_url: string | null }) => { if (d.website_url) existing.add(d.website_url); });
  }
  if (emails.length) {
    const { data } = await supabase.from("my_origami_leads").select("verified_email").in("verified_email", emails);
    (data ?? []).forEach((d: { verified_email: string | null }) => { if (d.verified_email) existing.add(`email:${d.verified_email.toLowerCase()}`); });
  }
  const fresh = batch.filter((r) => { const k = keyOf(r); return !k || !existing.has(k); });

  if (fresh.length === 0) {
    return json({ insertedCount: 0, leads: [], provider: providerName, note: "All matches were already in the database (deduped)." });
  }

  // Deliverability sanity check: verify each email's DOMAIN accepts mail (MX records)
  // before it ever hits the database. One lookup per unique domain (cached + parallel).
  const domains = [...new Set(fresh.map((r) => (r.verified_email.split("@")[1] || "").toLowerCase()).filter(Boolean))];
  const mx = new Map<string, boolean>();
  await Promise.all(domains.map(async (d) => { mx.set(d, await domainHasMx(d)); }));
  for (const r of fresh) {
    const domain = (r.verified_email.split("@")[1] || "").toLowerCase();
    r.email_confidence = !r.verified_email ? "none" : mx.get(domain) ? "medium" : "low";
  }

  // Insert; ignore any residual conflict on the website_url unique key (belt & suspenders).
  const { data, error } = await supabase
    .from("my_origami_leads")
    .upsert(fresh, { onConflict: "website_url", ignoreDuplicates: true })
    .select();
  if (error) return json({ error: `DB insert failed: ${error.message}`, leads: fresh }, 500);

  return json({ insertedCount: data?.length ?? 0, leads: data ?? fresh, provider: providerName, ...(meta ?? {}) });
});
