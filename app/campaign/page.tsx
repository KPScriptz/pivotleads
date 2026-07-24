'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Search, Mail, Sparkles, Play, ExternalLink, Copy, ShieldCheck, AlertTriangle, Circle, ArrowDown, Send, Download, Zap } from 'lucide-react';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jlgvaejxydcteciqzgub.supabase.co';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Lazy Supabase client — calling createClient() at module scope with an empty
// key throws "supabaseKey is required" during `next build` prerender (the anon
// key isn't set on Vercel at build time). Defer creation until a key exists so
// the build stays green; runtime behavior is identical when the key IS present.
let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!SUPABASE_ANON_KEY) return null;
  if (!_supabase) _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

interface Lead {
  id: string;
  person_name: string;
  linkedin_url: string;
  company_name: string;
  website_url: string;
  fit_score: number;
  buying_signal: string;
  decision_maker_title: string;
  verified_email: string;
  email_confidence?: string;
  created_at: string;
  // Shared team progress (persisted to the database via the edge function)
  stage?: string;
  tags?: string[];
  note?: string;
  rejected?: boolean;
  contacted_by?: string | null;
}

interface LeadNote { id: string; lead_id: string; author_email: string; author_name: string; body: string; created_at: string }

// Email deliverability label derived from the MX check stored in email_confidence.
// Light-mode: soft, low-saturation pills.
function emailStatus(conf?: string): { text: string; iconName: string; pill: string } {
  switch (conf) {
    case 'medium': return { text: 'Domain verified', iconName: 'shield', pill: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
    case 'low': return { text: 'Undeliverable', iconName: 'alert', pill: 'text-rose-600 bg-rose-50 border-rose-200' };
    case 'none': return { text: 'No email', iconName: 'dot', pill: 'text-gray-400 bg-gray-50 border-gray-200' };
    default: return { text: 'Unverified', iconName: 'dot', pill: 'text-gray-400 bg-gray-50 border-gray-200' };
  }
}

function Icon({ name, className = 'w-3.5 h-3.5' }: { name: string; className?: string }) {
  // lucide has no LinkedIn glyph in this version — render the "in" wordmark instead.
  if (name === 'linkedin') return <span className={`inline-flex items-center justify-center font-serif font-bold text-[10px] leading-none ${className}`}>in</span>;
  const map: Record<string, React.ComponentType<{ className?: string }>> = {
    search: Search, mail: Mail, sparkles: Sparkles, play: Play, external: ExternalLink,
    copy: Copy, shield: ShieldCheck, alert: AlertTriangle, dot: Circle,
    down: ArrowDown, send: Send, download: Download, zap: Zap,
  };
  const C = map[name] || Circle;
  return <C className={className} />;
}

// Highlight dynamic mail-merge fields ({first_name}, {{company}}, {title}) in
// brand green so the operator can see exactly what will be personalized.
const FIELD_RE = /(\{\{?\s*(?:first_name|company|title)\s*\}?\})/g;
const FIELD_TEST = /\{\{?\s*(?:first_name|company|title)\s*\}?\}/; // non-global: .test() is stateless
function Highlight({ text }: { text: string }) {
  const parts = text.split(FIELD_RE);
  return (
    <>
      {parts.map((p, i) =>
        FIELD_TEST.test(p)
          ? <span key={i} className="text-emerald-600 font-semibold">{p}</span>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}

// LinkedIn + Email dual sequence. Each node carries BOTH a LinkedIn body and an
// Email body; the `channel` toggle picks which one is the active draft.
type Channel = 'linkedin' | 'email' | 'inmail';
interface SeqNode { key: string; title: string; channel: Channel; linkedin: string; email: string; inmail: string; subject: string }
const DEFAULT_SEQUENCE: SeqNode[] = [
  {
    key: 'invite',
    title: 'LinkedIn Invite',
    channel: 'linkedin',
    linkedin: "Hi {first_name}, I follow {company}'s work and love what your team is building. I work on experiential brand-activation tech and would love to connect.",
    email: "Hi {first_name},\n\nI came across your work as {title} at {company} — we build a photo/AR capture experience that makes live activations more interactive and shareable. Worth a quick 15-min chat?\n\nBest",
    inmail: '',
    subject: 'Quick idea for {company}',
  },
  {
    key: 'followup',
    title: 'LinkedIn DM / Email Opener',
    channel: 'email',
    linkedin: "Thanks for connecting, {first_name}! Since you lead experiential at {company}, I thought I'd share what we do — a branded photo/AR capture moment for live events. Open to a quick look?",
    email: "Hi {first_name},\n\nFollowing up — we help teams like {company} turn live moments into shareable, on-brand content on the show floor. Could I send a 2-minute example tailored to your activations?\n\nBest",
    inmail: '',
    subject: '{first_name} — a thought on {company} activations',
  },
  {
    key: 'inmail',
    title: 'InMail',
    channel: 'inmail',
    linkedin: '',
    email: '',
    inmail: "Hi {first_name} — I lead partnerships for a photo/AR experience that makes live activations more interactive and shareable. Given your work as {title} at {company}, I thought it might be a fit. Open to a quick 15-minute look?",
    subject: 'A quick idea for {company}',
  },
];

// Real, publicly-sourced decision-makers at target experiential agencies.
// Verified against public sources by an automated research + fact-check pass on
// 2026-07-09. Emails are best-guess patterns (first.last@domain), NOT verified
// deliverable addresses — confirm with a real verification provider before outreach.
const INITIAL_DEMO_LEADS: Lead[] = [
  { id: "1", person_name: "Britt McCullars", linkedin_url: "https://www.linkedin.com/in/britt-mccullars-753600b/", company_name: "NEXT/NOW", website_url: "https://www.linkedin.com/in/britt-mccullars-753600b/", fit_score: 98, buying_signal: "Award-winning Executive Producer with 15+ years delivering immersive experiential installations, making her a direct decision-maker for greenlighting and staffing a photo/AR capture brand activation.", decision_maker_title: "Executive Producer", verified_email: "britt.mccullars@nextnowagency.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "2", person_name: "Roman Ivashnev", linkedin_url: "https://www.linkedin.com/in/ivashnev", company_name: "NEXT/NOW", website_url: "https://www.linkedin.com/in/ivashnev", fit_score: 98, buying_signal: "Associate Creative Director specializing in AR, metaverse, and immersive web UX, so he directly shapes the creative concept and interaction design of an AR/photo capture experience.", decision_maker_title: "Associate Creative Director", verified_email: "roman.ivashnev@nextnowagency.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "3", person_name: "Emily Burnham", linkedin_url: "https://www.linkedin.com/in/emily-burnham-a5820b26/", company_name: "NEXT/NOW", website_url: "https://www.linkedin.com/in/emily-burnham-a5820b26/", fit_score: 94, buying_signal: "Live-event and experiential XM Producer (ex-Live Nation) who manages custom immersive technology projects on the ground, exactly the person who would produce a photo/AR capture activation.", decision_maker_title: "Producer", verified_email: "emily.burnham@nextnowagency.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "4", person_name: "Karim Youssef", linkedin_url: "https://www.linkedin.com/in/bluesand/", company_name: "Groove Jones", website_url: "https://www.linkedin.com/in/bluesand/", fit_score: 98, buying_signal: "Award-winning senior creative lead for immersive AR/VR work, ideal to concept and art-direct an experiential photo/AR capture activation.", decision_maker_title: "Senior Creative Director", verified_email: "karim.youssef@groovejones.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "5", person_name: "Laura Vigliotti", linkedin_url: "https://www.linkedin.com/in/laura-vigliotti-b24b6772/", company_name: "Groove Jones", website_url: "https://www.linkedin.com/in/laura-vigliotti-b24b6772/", fit_score: 94, buying_signal: "Producer who manages end-to-end delivery of interactive AR/VR experiences, well-suited to run an on-site photo/AR capture activation.", decision_maker_title: "Producer", verified_email: "laura.vigliotti@groovejones.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "6", person_name: "Ashton Kennedy", linkedin_url: "https://www.linkedin.com/in/ashtonkennedy", company_name: "Groove Jones", website_url: "https://www.linkedin.com/in/ashtonkennedy", fit_score: 96, buying_signal: "Senior producer who designs, develops, and deploys branded VR/AR experiences, a strong fit to produce an experiential photo/AR capture activation.", decision_maker_title: "Senior Producer", verified_email: "ashton.kennedy@groovejones.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "7", person_name: "Jay Weissman", linkedin_url: "https://www.linkedin.com/in/jayweissman/", company_name: "Jack Morton", website_url: "https://www.linkedin.com/in/jayweissman/", fit_score: 98, buying_signal: "As an Executive Producer running large live brand events (Cadillac) at Jack Morton's NYC office, he directly commissions on-site experiential technology like photo and AR capture activations for attendees.", decision_maker_title: "Executive Producer", verified_email: "jay.weissman@jackmorton.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "8", person_name: "Kara Mitchell", linkedin_url: "https://www.linkedin.com/in/karakotlermitchell/", company_name: "Jack Morton", website_url: "https://www.linkedin.com/in/karakotlermitchell/", fit_score: 96, buying_signal: "A Senior Producer executing experiential events out of Jack Morton's San Francisco office, she is a hands-on buyer of interactive attendee touchpoints such as branded photo and AR capture experiences.", decision_maker_title: "Senior Producer", verified_email: "kara.mitchell@jackmorton.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "9", person_name: "Jackie Lavallee", linkedin_url: "https://www.linkedin.com/in/jackie-lavallee-556969210/", company_name: "Jack Morton", website_url: "https://www.linkedin.com/in/jackie-lavallee-556969210/", fit_score: 98, buying_signal: "An Executive Producer at Jack Morton's San Francisco experiential team, she owns event production budgets and would spec photo/AR capture activations to boost attendee engagement and social sharing.", decision_maker_title: "Executive Producer", verified_email: "jackie.lavallee@jackmorton.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "10", person_name: "Nick Coonce", linkedin_url: "https://www.linkedin.com/in/nickcoonce/", company_name: "VTProDesign", website_url: "https://www.linkedin.com/in/nickcoonce/", fit_score: 98, buying_signal: "As an Executive Producer who ran Netflix's Electric State press tour and the SAP Central immersive showcase, he directly scopes and greenlights experiential photo/AR capture activations.", decision_maker_title: "Executive Producer", verified_email: "nick.coonce@vtprodesign.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "11", person_name: "Nicole Blue", linkedin_url: "https://www.linkedin.com/in/nicole-blue-design/", company_name: "VTProDesign", website_url: "https://www.linkedin.com/in/nicole-blue-design/", fit_score: 98, buying_signal: "She leads large-scale brand activations for Netflix, Google, and Delta, making her the creative decision-maker for an experiential photo/AR capture moment.", decision_maker_title: "Associate Creative Director", verified_email: "nicole.blue@vtprodesign.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "12", person_name: "Akiko Yamashita", linkedin_url: "https://www.linkedin.com/in/akikoy/", company_name: "VTProDesign", website_url: "https://www.linkedin.com/in/akikoy/", fit_score: 98, buying_signal: "As a Creative Director building story-driven experiences with interactive tech, she is a natural buyer/champion for an AR-based capture activation.", decision_maker_title: "Creative Director", verified_email: "akiko.yamashita@vtprodesign.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "13", person_name: "Allen Goldman", linkedin_url: "https://www.linkedin.com/in/goldman-nyep/", company_name: "The Experiential Group", website_url: "https://www.linkedin.com/in/goldman-nyep/", fit_score: 96, buying_signal: "As a Senior Producer running experiential events, exhibits, and interactive content at TXG, he is a direct decision-maker for adding a branded photo/AR capture activation to a live brand experience.", decision_maker_title: "Senior Producer", verified_email: "allen.goldman@theexperientialgroup.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "14", person_name: "Erin McWhorter", linkedin_url: "https://www.linkedin.com/in/erinmcwhorter", company_name: "The Experiential Group", website_url: "https://www.linkedin.com/in/erinmcwhorter", fit_score: 98, buying_signal: "Leading production across TXG's experiential activations, she owns the vendor and technology decisions where a turnkey photo/AR capture experience would slot directly into her builds.", decision_maker_title: "Director of Production | Executive Producer", verified_email: "erin.mcwhorter@theexperientialgroup.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "15", person_name: "Geanina Fidiles", linkedin_url: "https://www.linkedin.com/in/geanina-fidiles-40087087/", company_name: "VOLO Events Agency", website_url: "https://www.linkedin.com/in/geanina-fidiles-40087087/", fit_score: 98, buying_signal: "As Executive Creative Director she owns the creative concepting for VOLO's live brand activations, making her a direct decision-maker for adding an AR/photo capture experience to an event.", decision_maker_title: "Executive Creative Director", verified_email: "geanina.fidiles@voloevents.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "16", person_name: "Don Ferman", linkedin_url: "", company_name: "VOLO Events Agency", website_url: "https://voloevents.com", fit_score: 98, buying_signal: "As Creative Director he shapes experiential concepts for VOLO's Fortune 1000 activations, a natural champion for a branded photo/AR capture experience on the show floor.", decision_maker_title: "Creative Director", verified_email: "don.ferman@voloevents.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "17", person_name: "Camille Arnold", linkedin_url: "https://www.linkedin.com/in/camille-arnold/", company_name: "Splash", website_url: "https://www.linkedin.com/in/camille-arnold/", fit_score: 98, buying_signal: "As Splash's Director of Experiential Marketing she owns the brand's in-person activations and attendee-experience strategy, making her the direct decision-maker for adding an experiential photo/AR capture activation to Splash events.", decision_maker_title: "Director of Experiential Marketing", verified_email: "camille.arnold@splashthat.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "18", person_name: "Kaitland Hunter", linkedin_url: "https://www.linkedin.com/in/kaitlandhunter/", company_name: "Impact XM", website_url: "https://www.linkedin.com/in/kaitlandhunter/", fit_score: 98, buying_signal: "As Executive Creative Director she sets the creative vision for Impact XM's brand activations, making her a decision-maker for an experiential photo/AR capture experience.", decision_maker_title: "Executive Creative Director", verified_email: "kaitland.hunter@impact-xm.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "19", person_name: "Michael Rubenstein", linkedin_url: "https://www.linkedin.com/in/mrmichaelrubenstein/", company_name: "Impact XM", website_url: "https://www.linkedin.com/in/mrmichaelrubenstein/", fit_score: 98, buying_signal: "As an executive experiential and content producer he owns the production of on-site activations and content, directly responsible for integrating a photo/AR capture experience.", decision_maker_title: "Executive Producer", verified_email: "michael.rubenstein@impact-xm.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "20", person_name: "Rachel Andrews", linkedin_url: "https://www.linkedin.com/in/rachel-k-andrews/", company_name: "Cvent", website_url: "https://www.linkedin.com/in/rachel-k-andrews/", fit_score: 98, buying_signal: "She owns Cvent's flagship experiential user conference (Cvent CONNECT) and 1,200+ events a year, making her the direct decision-maker for adding a branded photo/AR capture activation to Cvent's live events.", decision_maker_title: "Global Head of Meetings & Events (Global Senior Director, Meetings & Events)", verified_email: "rachel.andrews@cvent.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "21", person_name: "RJ Jewell", linkedin_url: "https://www.linkedin.com/in/rj-jewell-55a54225/", company_name: "Cvent", website_url: "https://www.linkedin.com/in/rj-jewell-55a54225/", fit_score: 94, buying_signal: "As Cvent's senior in-house producer of on-site event and video content (Cvent CONNECT), he owns the capture/content experience that a photo/AR activation would plug directly into.", decision_maker_title: "Senior Video Producer", verified_email: "rj.jewell@cvent.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "22", person_name: "Madelyn Welch", linkedin_url: "https://www.linkedin.com/in/madelynwelch/", company_name: "Socialive", website_url: "https://www.linkedin.com/in/madelynwelch/", fit_score: 96, buying_signal: "A technical/video producer who has headed production for 75+ live video events at Socialive, she is well positioned to spec and produce an experiential photo/AR capture activation as part of an event's video program.", decision_maker_title: "Technical Producer", verified_email: "madelyn.welch@socialive.us", created_at: "2026-07-09T00:00:00Z" },
  { id: "23", person_name: "Mili Marcetic", linkedin_url: "https://www.linkedin.com/in/mili-marcetic-16419310/", company_name: "MKG", website_url: "https://www.linkedin.com/in/mili-marcetic-16419310/", fit_score: 98, buying_signal: "As MKG's director of production / executive producer leading production across both coasts and a BizBash 2024 Industry Innovator focused on new tech, she is the decision-maker who would greenlight an experiential photo/AR capture activation.", decision_maker_title: "Director of Production / Executive Producer", verified_email: "mili.marcetic@thisismkg.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "24", person_name: "Sarah Bross", linkedin_url: "https://www.linkedin.com/in/sarah-bross-216b06104/", company_name: "MKG", website_url: "https://www.linkedin.com/in/sarah-bross-216b06104/", fit_score: 96, buying_signal: "A Senior Producer who has run multi-city international brand activations and pop-ups like HomeGoods Hideouts, she directly scopes and books capture/AR experiences for MKG builds.", decision_maker_title: "Senior Producer", verified_email: "sarah.bross@thisismkg.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "25", person_name: "Chandler Blasini", linkedin_url: "https://www.linkedin.com/in/chandlerblasini/", company_name: "MKG", website_url: "https://www.linkedin.com/in/chandlerblasini/", fit_score: 94, buying_signal: "An LA-based experiential Producer who worked on entertainment activations like Netflix's Poguelandia, exactly the kind of guest-facing event where a photo/AR capture moment would be deployed.", decision_maker_title: "Producer", verified_email: "chandler.blasini@thisismkg.com", created_at: "2026-07-09T00:00:00Z" },
  { id: "26", person_name: "Lauren Sorenson", linkedin_url: "https://www.linkedin.com/in/laurashsor/", company_name: "Bizzabo", website_url: "https://www.linkedin.com/in/laurashsor/", fit_score: 96, buying_signal: "She owns all of Bizzabo's brand experiences, dinners (the Bizzy dinner series), third-party sponsorships, and on-site presence, making her the direct buyer for an experiential photo/AR capture activation; her background is experiential agency work running music festivals.", decision_maker_title: "Director, Brand Experience", verified_email: "lauren.sorenson@bizzabo.com", created_at: "2026-07-09T00:00:00Z" }
];

const TABS = ['Overview', 'People', 'Messages', 'Review', 'Settings'] as const;
type Tab = typeof TABS[number];

// Stage machine. Contacted → Accepted (connect accepted) → Replied → Won.
const STAGES = ['New', 'Contacted', 'Accepted', 'Replied', 'Won'] as const;
const STAGE_STYLES: Record<string, string> = {
  New: 'text-gray-500 bg-gray-50 border-gray-200',
  Contacted: 'text-sky-700 bg-sky-50 border-sky-200',
  Accepted: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  Replied: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  Won: 'text-emerald-700 bg-emerald-50 border-emerald-200',
};

export default function CampaignWorkspace() {
  const [leads, setLeads] = useState<Lead[]>(INITIAL_DEMO_LEADS);
  const [activeTab, setActiveTab] = useState<Tab>('Overview');

  // Individual sign-in (Supabase Auth). Each teammate has their own account;
  // their name drives "Contacted by" attribution and note authorship.
  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState<{ email: string; name: string } | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPw, setAuthPw] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState('');

  // Sourcing config
  const [provider, setProvider] = useState<'serper' | 'apollo'>('serper');
  const [targetLinksText, setTargetLinksText] = useState('');
  const [icpRules, setIcpRules] = useState('US-based experiential technology directors or agency interactive producers who buy on-site brand-activation experiences.');
  const [apolloCap, setApolloCap] = useState(10);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<{ type: 'idle' | 'info' | 'ok' | 'err'; text: string }>({ type: 'idle', text: '' });

  // Per-lead progress (stage / tags / note / rejected) — lives on the lead row in
  // the database so the whole team shares it. Reads come from the `leads` state
  // (fetched from the DB); writes go through the edge function's service role.
  type LeadMeta = { tags: string[]; note: string; rejected: boolean; stage: string };

  // People view
  const [search, setSearch] = useState('');
  const [peopleFilter, setPeopleFilter] = useState<'All' | 'Ready' | 'Contacted'>('Ready');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [tagInput, setTagInput] = useState('');
  // Shared team notes for the open lead (everyone sees everyone's notes).
  const [leadNotes, setLeadNotes] = useState<LeadNote[]>([]);
  const [noteInput, setNoteInput] = useState('');

  // Template sequence
  const [sequence, setSequence] = useState<SeqNode[]>(DEFAULT_SEQUENCE);

  // Outreach + settings
  const [senderPitch, setSenderPitch] = useState('');
  const [outreach, setOutreach] = useState<{ note: string; email: string } | null>(null);
  const [composing, setComposing] = useState(false);
  const [sentToday, setSentToday] = useState(0);
  const [dailyTarget, setDailyTarget] = useState(25);
  const [toast, setToast] = useState('');
  // Email preferences: which client opens, and a CAN-SPAM compliance footer.
  const [mailClient, setMailClient] = useState<'gmail' | 'outlook' | 'default'>('gmail');
  const DEFAULT_FOOTER = "—\nYou're receiving this because I thought it could be relevant to your work at {company}. If you'd prefer not to hear from me, just reply \"unsubscribe\" and I won't reach out again.\n[Your company] · [Your mailing address]";
  const [emailFooter, setEmailFooter] = useState(DEFAULT_FOOTER);
  // Optional sequencer webhook (Zapier / Make / Instantly / Smartlead) — paste once in Settings.
  const [webhookUrl, setWebhookUrl] = useState('');
  // Let a signed-in teammate set their own password.
  const [pwNew, setPwNew] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // AI command bar
  const [cmd, setCmd] = useState('');
  const [cmdBusy, setCmdBusy] = useState(false);
  const [aiReply, setAiReply] = useState('');

  // Fast queue (focus mode)
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [focusQueue, setFocusQueue] = useState<Lead[]>([]);

  /* ---------------------------------------------------------------------- */
  /*  Persistence                                                            */
  /* ---------------------------------------------------------------------- */
  useEffect(() => {
    try { const p = localStorage.getItem('pivotleads_pitch_v1'); if (p) setSenderPitch(p); } catch { /* ignore */ }
    try {
      const s = localStorage.getItem('pivotleads_sequence_v1');
      if (s) {
        const parsed = JSON.parse(s) as SeqNode[];
        // Backfill the InMail node + field for sequences saved before InMail existed.
        const withInmail = parsed.map((n) => ({ ...n, inmail: n.inmail ?? '' }));
        if (!withInmail.some((n) => n.channel === 'inmail')) withInmail.push(DEFAULT_SEQUENCE[2]);
        setSequence(withInmail);
      }
    } catch { /* ignore */ }
    try { const s = localStorage.getItem('pivotleads_sent_v1'); if (s) { const o = JSON.parse(s); const today = new Date().toISOString().slice(0, 10); setSentToday(o.date === today ? o.count : 0); } } catch { /* ignore */ }
    try { const t = localStorage.getItem('pivotleads_target_v1'); if (t) setDailyTarget(Math.max(1, Math.min(200, Number(t) || 25))); } catch { /* ignore */ }
    try { const m = localStorage.getItem('pivotleads_mailclient_v1'); if (m === 'gmail' || m === 'outlook' || m === 'default') setMailClient(m); } catch { /* ignore */ }
    try { const f = localStorage.getItem('pivotleads_footer_v1'); if (f !== null) setEmailFooter(f); } catch { /* ignore */ }
    try { const w = localStorage.getItem('pivotleads_webhook_v1'); if (w) setWebhookUrl(w); } catch { /* ignore */ }
  }, []);

  const flash = (text: string) => { setToast(text); window.setTimeout(() => setToast((t) => (t === text ? '' : t)), 3200); };

  const getMeta = (id: string): LeadMeta => {
    const l = leads.find((x) => x.id === id);
    return { tags: l?.tags ?? [], note: l?.note ?? '', rejected: l?.rejected ?? false, stage: l?.stage ?? 'New' };
  };
  // Optimistic local update (instant UI) — used by both the DB writer and note debounce.
  const patchLeadLocal = (id: string, patch: Partial<Lead>) =>
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  // Persist a patch to the shared database (fire-and-forget; UI already updated).
  const persistMeta = async (id: string, patch: Partial<LeadMeta>) => {
    if (!SUPABASE_ANON_KEY) return;
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/pivotleads`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ action: 'update_meta', lead_id: id, patch }),
      });
      if (!r.ok) console.warn('Progress save failed for', id);
    } catch { /* offline; local copy stands */ }
  };
  const updateMeta = (id: string, patch: Partial<LeadMeta>) => { patchLeadLocal(id, patch); persistMeta(id, patch); };
  const getStage = (id: string) => getMeta(id).stage || 'New';
  const bumpSent = () => {
    const today = new Date().toISOString().slice(0, 10);
    let stored: { date: string; count: number } = { date: today, count: 0 };
    try { const raw = localStorage.getItem('pivotleads_sent_v1'); if (raw) stored = JSON.parse(raw); } catch { /* ignore */ }
    const count = (stored.date === today ? stored.count : 0) + 1;
    try { localStorage.setItem('pivotleads_sent_v1', JSON.stringify({ date: today, count })); } catch { /* ignore */ }
    setSentToday(count);
  };
  const setStage = (id: string, stage: string) => {
    if (stage === 'Contacted' && getStage(id) !== 'Contacted') bumpSent();
    // Optimistic attribution locally; the server stamps the authoritative value.
    patchLeadLocal(id, { stage, contacted_by: stage === 'New' ? null : (authUser?.name || null) });
    persistMeta(id, { stage });
  };
  const addTag = (id: string, tag: string) => { const t = tag.trim(); if (!t) return; const cur = getMeta(id); if (!cur.tags.includes(t)) updateMeta(id, { tags: [...cur.tags, t] }); };
  const removeTag = (id: string, tag: string) => updateMeta(id, { tags: getMeta(id).tags.filter((x) => x !== tag) });

  const copy = (text: string) => { try { navigator.clipboard.writeText(text); } catch { /* ignore */ } };
  const savePitch = (p: string) => { setSenderPitch(p); try { localStorage.setItem('pivotleads_pitch_v1', p); } catch { /* ignore */ } };
  const saveMailClient = (c: 'gmail' | 'outlook' | 'default') => { setMailClient(c); try { localStorage.setItem('pivotleads_mailclient_v1', c); } catch { /* ignore */ } };
  const saveEmailFooter = (f: string) => { setEmailFooter(f); try { localStorage.setItem('pivotleads_footer_v1', f); } catch { /* ignore */ } };
  const saveWebhookUrl = (w: string) => { setWebhookUrl(w.trim()); try { localStorage.setItem('pivotleads_webhook_v1', w.trim()); } catch { /* ignore */ } };
  const saveDailyTarget = (n: number) => { const v = Math.max(1, Math.min(200, Math.round(n) || 25)); setDailyTarget(v); try { localStorage.setItem('pivotleads_target_v1', String(v)); } catch { /* ignore */ } };
  const saveSequence = (s: SeqNode[]) => { setSequence(s); try { localStorage.setItem('pivotleads_sequence_v1', JSON.stringify(s)); } catch { /* ignore */ } };
  const updateNode = (i: number, patch: Partial<SeqNode>) => saveSequence(sequence.map((n, j) => (j === i ? { ...n, ...patch } : n)));

  // Mail-merge renderer — supports {field} and {{field}} for first_name/company/title.
  const renderFor = (t: string, l?: Lead) => (t || '')
    .replace(/\{\{?\s*first_name\s*\}?\}/g, (l?.person_name || '').split(' ')[0] || 'there')
    .replace(/\{\{?\s*company\s*\}?\}/g, l?.company_name || 'your company')
    .replace(/\{\{?\s*title\s*\}?\}/g, l?.decision_maker_title || 'your role');

  // Their LinkedIn profile if we have it, else a LinkedIn people-search.
  const linkedInHref = (l: Lead) => {
    const u = l.linkedin_url || l.website_url || '';
    if (u.includes('linkedin.com/in')) return u;
    const query = encodeURIComponent(`${l.person_name || ''} ${l.company_name || ''}`.trim());
    return `https://www.linkedin.com/search/results/people/?keywords=${query}`;
  };
  const inviteNode = sequence[0];
  const emailNode = sequence.find((n) => n.channel === 'email') || sequence[0];
  const inmailNode = sequence.find((n) => n.channel === 'inmail') || DEFAULT_SEQUENCE[2];
  // Build an email-compose URL for the user's chosen client, with the CAN-SPAM
  // footer appended so every emailed draft carries an opt-out + address line.
  const emailUrl = (l: Lead, node: SeqNode) => {
    const to = l.verified_email || '';
    const subject = renderFor(node.subject || 'Quick idea for {company}', l);
    const footer = emailFooter.trim() ? `\n\n${renderFor(emailFooter, l)}` : '';
    const body = `${renderFor(node.email, l)}${footer}`;
    const s = encodeURIComponent(subject);
    const b = encodeURIComponent(body);
    const t = encodeURIComponent(to);
    if (mailClient === 'gmail') return `https://mail.google.com/mail/?view=cm&fs=1&to=${t}&su=${s}&body=${b}`;
    if (mailClient === 'outlook') return `https://outlook.office.com/mail/deeplink/compose?to=${t}&subject=${s}&body=${b}`;
    return `mailto:${to}?subject=${s}&body=${b}`;
  };

  // Point-5 action: "Ready to send" fires the REAL LinkedIn copy + Email mailto.
  const quickSend = (l: Lead) => {
    copy(renderFor(inviteNode.linkedin, l));
    const first = (l.person_name || '').split(' ')[0] || 'lead';
    if (l.verified_email) {
      window.open(emailUrl(l, emailNode), '_blank');
      flash(`Copied LinkedIn invite for ${first} + opened email draft. Marked Contacted.`);
    } else {
      window.open(linkedInHref(l), '_blank', 'noopener');
      flash(`Copied LinkedIn invite for ${first} + opened LinkedIn. Marked Contacted.`);
    }
    setStage(l.id, 'Contacted');
  };

  // Row-level 1-click copy: grab the personalized text, mark Contacted, sync the team.
  // Copy only — no longer auto-marks Contacted, so you can grab both the note AND
  // the email before marking. Use the "Mark contacted" button when you've sent.
  const quickCopyNote = (l: Lead) => {
    copy(renderFor(inviteNode.linkedin, l));
    flash(`LinkedIn note for ${(l.person_name || '').split(' ')[0] || 'lead'} copied. Paste it, then hit “Mark contacted”.`);
  };
  const quickCopyEmail = (l: Lead) => {
    if (!l.verified_email) return;
    const subject = renderFor(emailNode.subject || 'Quick idea for {company}', l);
    copy(`Subject: ${subject}\n\n${renderFor(emailNode.email, l)}`);
    flash(`Email for ${(l.person_name || '').split(' ')[0] || 'lead'} copied. Paste it, then hit “Mark contacted”.`);
  };

  // One-click push into the user's cold-email sequencer via their saved webhook.
  const pushToSequencer = async (l: Lead) => {
    if (!webhookUrl || !l.verified_email) return;
    const first = (l.person_name || '').split(' ')[0] || 'lead';
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/pivotleads`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          action: 'push_webhook',
          webhook_url: webhookUrl,
          payload: {
            source: 'pivot-leads',
            person_name: l.person_name,
            first_name: (l.person_name || '').split(' ')[0] || '',
            title: l.decision_maker_title,
            company: l.company_name,
            email: l.verified_email,
            linkedin_url: l.linkedin_url || '',
            fit_score: l.fit_score,
            icebreaker: renderFor(inviteNode.linkedin, l),
            email_subject: renderFor(emailNode.subject, l),
            email_body: renderFor(emailNode.email, l),
          },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      setStage(l.id, 'Contacted');
      flash(`${first} sent to your sequencer — marked Contacted.`);
    } catch (e) {
      flash(`Couldn’t push ${first}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Sales Navigator InMail — copy the InMail message, open their profile so you can
  // paste it into the InMail composer (works without being connected). Manual send.
  const sendInmail = (l: Lead) => {
    copy(renderFor(inmailNode.inmail, l));
    window.open(linkedInHref(l), '_blank', 'noopener');
    setStage(l.id, 'Contacted');
    flash(`Copied InMail for ${(l.person_name || '').split(' ')[0] || 'lead'} + opened their profile. Paste it into the InMail box. Marked Contacted.`);
  };

  const toggleSelect = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /* ---------------------------------------------------------------------- */
  /*  Derived data                                                           */
  /* ---------------------------------------------------------------------- */
  const active = leads.filter((l) => !getMeta(l.id).rejected);
  const isContacted = (id: string) => ['Contacted', 'Accepted', 'Replied', 'Won'].includes(getStage(id));
  const metrics = {
    people: active.length,
    contacted: active.filter((l) => isContacted(l.id)).length,
    accepted: active.filter((l) => ['Accepted', 'Replied', 'Won'].includes(getStage(l.id))).length,
    replied: active.filter((l) => ['Replied', 'Won'].includes(getStage(l.id))).length,
  };
  const funnel = [
    { label: 'People', n: metrics.people },
    { label: 'Contacted', n: metrics.contacted },
    { label: 'Connect accepted', n: metrics.accepted },
    { label: 'Replied', n: metrics.replied },
  ];

  const contactedCount = active.filter((l) => isContacted(l.id)).length;
  const toContactCount = active.length - contactedCount;
  const q = search.trim().toLowerCase();
  const filteredLeads = active.filter((l) => {
    if (peopleFilter === 'Ready' && isContacted(l.id)) return false;
    if (peopleFilter === 'Contacted' && !isContacted(l.id)) return false;
    if (q) {
      const hay = [l.person_name, l.decision_maker_title, l.company_name, l.verified_email, ...getMeta(l.id).tags].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const allVisibleSelected = filteredLeads.length > 0 && filteredLeads.every((l) => selected.has(l.id));
  const toggleSelectAll = () => setSelected(allVisibleSelected ? new Set() : new Set(filteredLeads.map((l) => l.id)));
  const sampleLead = filteredLeads[0] || leads[0];

  const sourceCounts = Object.entries(
    active.reduce((acc, l) => { const k = l.company_name || '—'; acc[k] = (acc[k] || 0) + 1; return acc; }, {} as Record<string, number>),
  ).sort((a, b) => b[1] - a[1]).slice(0, 6);

  /* ---------------------------------------------------------------------- */
  /*  Live data + pipeline                                                   */
  /* ---------------------------------------------------------------------- */
  const fetchLiveLeads = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const { data, error } = await supabase.from('my_origami_leads').select('*').order('created_at', { ascending: false });
      if (!error && data && data.length > 0) {
        setLeads((data as unknown as Lead[]).map((r) => ({ ...r, linkedin_url: r.linkedin_url || r.website_url || '' })));
      }
    } catch (err) {
      console.warn('Database fetch bypassed.', err);
    }
  };

  // Session bootstrap + keep authUser in sync with Supabase Auth.
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) { setAuthChecked(true); return; }
    const toUser = (u: { email?: string; user_metadata?: Record<string, unknown> } | null | undefined) =>
      u?.email ? { email: u.email, name: String(u.user_metadata?.name || u.email.split('@')[0]) } : null;
    supabase.auth.getSession().then(({ data }) => { setAuthUser(toUser(data.session?.user)); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setAuthUser(toUser(session?.user)));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Load the shared list once someone is signed in (reads are RLS-gated to the team).
  useEffect(() => { if (authUser) fetchLiveLeads(); }, [authUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase || !authEmail || !authPw || authBusy) return;
    setAuthBusy(true); setAuthErr('');
    // Accept a bare username (e.g. "goat") — assume the team domain when there's no "@".
    const id = authEmail.trim().toLowerCase();
    const email = id.includes('@') ? id : `${id}@pivotxp.com`;
    const { error } = await supabase.auth.signInWithPassword({ email, password: authPw });
    if (error) { setAuthErr('Wrong username or password. Try again.'); setAuthBusy(false); return; }
    setAuthPw(''); setAuthBusy(false);
  };
  const signOut = async () => { await getSupabase()?.auth.signOut(); setLeads(INITIAL_DEMO_LEADS); };

  const changePassword = async () => {
    const supabase = getSupabase();
    if (!supabase || pwBusy) return;
    if (pwNew.length < 8) { setPwMsg({ ok: false, text: 'Use at least 8 characters.' }); return; }
    setPwBusy(true); setPwMsg(null);
    const { error } = await supabase.auth.updateUser({ password: pwNew });
    if (error) setPwMsg({ ok: false, text: error.message });
    else { setPwMsg({ ok: true, text: 'Password updated — you’ll use it next time you sign in.' }); setPwNew(''); }
    setPwBusy(false);
  };

  // Edge-function calls carry the signed-in user's token (the anon key alone is rejected).
  const authHeaders = async (): Promise<Record<string, string>> => {
    const supabase = getSupabase();
    const token = (await supabase?.auth.getSession())?.data.session?.access_token || SUPABASE_ANON_KEY;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY };
  };

  const handleRun = async (mode: 'target' | 'discover' = 'target', src: 'serper' | 'apollo' = provider) => {
    if (!SUPABASE_ANON_KEY) { setRunMsg({ type: 'err', text: 'Lead finding isn’t connected yet. Add your Supabase key and try again.' }); return; }
    const urls = targetLinksText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (mode === 'target' && urls.length === 0) { setRunMsg({ type: 'err', text: 'Paste at least one company website or LinkedIn page above first.' }); return; }
    setRunning(true);
    setRunMsg({ type: 'info', text: 'Finding leads — this takes about 2–3 minutes. You can keep working; new people appear here when it’s done.' });
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/pivotleads`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ targetLinks: urls, icpRules, provider: src, mode, enrichCap: src === 'apollo' ? apolloCap : undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
      const inserted = data?.insertedCount ?? 0;
      setRunMsg({ type: 'ok', text: `Done — added ${inserted} new ${inserted === 1 ? 'person' : 'people'} to your list.${data?.note ? ' ' + data.note : ''}` });
      fetchLiveLeads();
    } catch (e) {
      setRunMsg({ type: 'err', text: `Couldn’t finish: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRunning(false);
    }
  };

  // AI Outreach Composer — real edge function (action: 'compose'). Drafts only; you send.
  const composeOutreach = async () => {
    if (!selectedLead || !SUPABASE_ANON_KEY) return;
    setComposing(true); setOutreach(null);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/pivotleads`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ action: 'compose', lead: selectedLead, senderContext: senderPitch || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      setOutreach({ note: data?.connection_note || '', email: data?.email_opener || '' });
    } catch (e) {
      setOutreach({ note: '', email: `Error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setComposing(false);
    }
  };
  useEffect(() => { setOutreach(null); }, [selectedLead?.id]);

  // Load the shared notes thread whenever a lead's panel opens.
  useEffect(() => {
    setLeadNotes([]); setNoteInput('');
    const supabase = getSupabase();
    const id = selectedLead?.id;
    if (!supabase || !id) return;
    supabase.from('lead_notes').select('*').eq('lead_id', id).order('created_at', { ascending: true })
      .then(({ data }) => { setLeadNotes((data as unknown as LeadNote[]) || []); });
  }, [selectedLead?.id]);

  const addNote = async () => {
    const supabase = getSupabase();
    const body = noteInput.trim();
    if (!supabase || !selectedLead || !authUser || !body) return;
    setNoteInput('');
    const payload = { lead_id: selectedLead.id, author_email: authUser.email, author_name: authUser.name, body };
    const { data, error } = await supabase
      .from('lead_notes')
      .insert(payload as never)
      .select()
      .single();
    if (!error && data) setLeadNotes((prev) => [...prev, data as unknown as LeadNote]);
    else flash('Couldn’t save that note — try again.');
  };

  /* ---------------------------------------------------------------------- */
  /*  Fast queue (focus mode)                                                */
  /* ---------------------------------------------------------------------- */
  const openFocus = () => {
    const queue = active
      .filter((l) => getStage(l.id) === 'New' && (l.verified_email || l.linkedin_url || l.website_url))
      .slice()
      .sort((a, b) => (b.email_confidence === 'medium' ? 1 : 0) - (a.email_confidence === 'medium' ? 1 : 0) || b.fit_score - a.fit_score);
    setFocusQueue(queue); setFocusIdx(0); setFocusOpen(true);
  };
  const focusNext = () => setFocusIdx((i) => i + 1);
  const focusEmail = (l: Lead) => { if (!l.verified_email) return; window.open(emailUrl(l, emailNode), '_blank'); };
  const focusLinkedIn = (l: Lead) => { copy(renderFor(inviteNode.linkedin, l)); window.open(linkedInHref(l), '_blank', 'noopener'); };
  useEffect(() => {
    if (!focusOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const cur = focusQueue[focusIdx];
      if (e.key === 'Escape') { setFocusOpen(false); return; }
      if (!cur) return;
      if (e.key === 'e') focusEmail(cur);
      else if (e.key === 'l') focusLinkedIn(cur);
      else if (e.key === 'Enter' || e.key === 'n') { setStage(cur.id, 'Contacted'); focusNext(); }
      else if (e.key === 's') focusNext();
      else if (e.key === 'r') { updateMeta(cur.id, { rejected: true }); focusNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusOpen, focusIdx, focusQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------------- */
  /*  Export                                                                 */
  /* ---------------------------------------------------------------------- */
  const exportCsv = () => {
    const rows = selected.size > 0 ? filteredLeads.filter((l) => selected.has(l.id)) : filteredLeads;
    const header = ['person_name', 'decision_maker_title', 'company_name', 'linkedin_url', 'verified_email', 'email_confidence', 'fit_score', 'stage', 'buying_signal', 'created_at'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows.map((l) => [l.person_name, l.decision_maker_title, l.company_name, l.linkedin_url, l.verified_email, l.email_confidence || '', l.fit_score, getStage(l.id), l.buying_signal, l.created_at].map(esc).join(','));
    const csv = [header.join(','), ...body].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `pivotleads-${rows.length}-leads.csv`; a.click(); URL.revokeObjectURL(url);
    flash(`Exported ${rows.length} lead${rows.length === 1 ? '' : 's'} to CSV.`);
  };

  /* ---------------------------------------------------------------------- */
  /*  AI command bar — asks Claude (edge function 'assist'), applies actions  */
  /* ---------------------------------------------------------------------- */
  const applyAiAction = (action: string) => {
    switch (action) {
      case 'discover': setActiveTab('Overview'); handleRun('discover'); break;
      case 'export_csv': exportCsv(); break;
      case 'fast_queue': openFocus(); break;
      case 'goto_overview': setActiveTab('Overview'); break;
      case 'goto_people': setActiveTab('People'); break;
      case 'goto_template': setActiveTab('Messages'); break;
      case 'goto_review': setActiveTab('Review'); break;
      case 'goto_settings': setActiveTab('Settings'); break;
      default: break;
    }
  };
  const runCommand = async () => {
    const t = cmd.trim();
    if (!t || cmdBusy) return;
    if (!SUPABASE_ANON_KEY) { setAiReply('Claude isn’t configured yet — add NEXT_PUBLIC_SUPABASE_ANON_KEY (and the ANTHROPIC_API_KEY Supabase secret) to enable the AI copilot.'); return; }
    setCmd(''); setCmdBusy(true); setAiReply('');
    try {
      const context = {
        tab: activeTab,
        provider,
        people: metrics.people,
        contacted: metrics.contacted,
        connect_accepted: metrics.accepted,
        replied: metrics.replied,
        icp: icpRules,
        top_companies: sourceCounts.map(([n, c]) => `${n} (${c})`),
        sample_lead: sampleLead ? { name: sampleLead.person_name, title: sampleLead.decision_maker_title, company: sampleLead.company_name } : null,
      };
      const res = await fetch(`${SUPABASE_URL}/functions/v1/pivotleads`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ action: 'assist', prompt: t, senderContext: senderPitch || undefined, context }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      setAiReply(data?.reply || 'Done.');
      if (data?.action && data.action !== 'none') applyAiAction(data.action);
    } catch (e) {
      setAiReply(`Couldn’t reach Claude: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCmdBusy(false);
    }
  };

  /* ====================================================================== */
  /*  Render                                                                 */
  /* ====================================================================== */
  const cardCls = 'bg-white border border-gray-200 rounded-xl shadow-sm';
  const inputCls = 'bg-gray-50 border border-gray-200 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100';

  if (!authChecked) {
    return <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center text-sm text-gray-400 font-sans">Loading…</div>;
  }
  if (!authUser) {
    return (
      <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center px-4 font-sans">
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-600 font-bold">Campaign</div>
            <div className="text-2xl font-bold tracking-tight text-gray-900 mt-1">Pivot <span className="text-emerald-600">Leads</span></div>
          </div>
          <form onSubmit={signIn} className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-3">
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1.5">Username or email</label>
              <input type="text" value={authEmail} autoFocus autoComplete="username" onChange={(e) => { setAuthEmail(e.target.value); setAuthErr(''); }} placeholder="your username" className={`w-full ${inputCls} px-3 py-2.5 text-sm`} />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1.5">Password</label>
              <input type="password" value={authPw} autoComplete="current-password" onChange={(e) => { setAuthPw(e.target.value); setAuthErr(''); }} placeholder="Your password" className={`w-full ${inputCls} px-3 py-2.5 text-sm`} />
            </div>
            {authErr && <div className="text-[13px] text-rose-600">{authErr}</div>}
            <button type="submit" disabled={authBusy || !authEmail || !authPw} className="w-full bg-[#48f4ad] hover:brightness-105 disabled:opacity-50 text-[#04231a] text-sm font-bold py-2.5 rounded-lg transition-all">
              {authBusy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <div className="text-center text-[11px] text-gray-400 mt-4">Private team workspace — accounts are created by your admin.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans text-gray-900 antialiased bg-[#F4F5F7] pb-28">
      {/* Campaign header */}
      <div className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-gray-200 px-4 sm:px-8 pt-5 sm:pt-6 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-600 font-bold flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#48f4ad]" /> Campaign
            </div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3 mt-1.5 text-gray-900">
              Pivot <span className="text-emerald-600">Leads</span>
            </h1>
            <p className="text-[13px] text-gray-500 mt-2 max-w-xl leading-relaxed">Find the right people, then reach out with a personal note and email — all sent by you, in a few clicks.</p>
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap justify-end">
            <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-gray-600 bg-white border border-gray-200 rounded-full pl-1.5 pr-3 py-1">
              <span className="w-6 h-6 rounded-full bg-[#48f4ad] text-[#04231a] font-bold text-[11px] grid place-items-center uppercase">{authUser?.name?.charAt(0) || '?'}</span>
              {authUser?.name}
              <button onClick={signOut} className="text-gray-400 hover:text-gray-700 font-medium">Sign out</button>
            </span>
            <button onClick={exportCsv} className="bg-gray-900 hover:bg-black text-white text-xs font-semibold py-2 px-3.5 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm">
              <Icon name="download" /> Export CSV
            </button>
          </div>
        </div>

        {/* Five-step stepper — rounded pill tabs */}
        <div className="mt-6 flex gap-1.5 overflow-x-auto">
          {TABS.map((tab, idx) => {
            const on = activeTab === tab;
            const stepDone =
              (tab === 'Overview' && metrics.people > 0) ||
              (tab === 'People' && metrics.people > 0) ||
              (tab === 'Messages') ||
              (tab === 'Review' && metrics.contacted > 0) ||
              (tab === 'Settings' && !!senderPitch);
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${on ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'text-gray-500 hover:bg-gray-100'}`}
              >
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${on ? 'bg-[#48f4ad] text-[#04231a]' : stepDone ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-500'}`}>
                  {stepDone && !on ? '✓' : idx + 1}
                </span>
                {tab}
                {tab === 'People' && <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${on ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-600'}`}>{metrics.people}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ================= OVERVIEW ================= */}
      {activeTab === 'Overview' && (
        <div className="mx-4 sm:mx-8 mt-6 mb-6 space-y-4">
          {/* 4-card metric summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([
              ['People', metrics.people],
              ['Contacted', metrics.contacted],
              ['Connect accepted', metrics.accepted],
              ['Replied', metrics.replied],
            ] as [string, number][]).map(([label, val]) => (
              <div key={label} className={`${cardCls} px-4 py-3.5`}>
                <div className="text-3xl font-black text-gray-900 tabular-nums">{val}</div>
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-[0.12em] mt-1">{label}</div>
              </div>
            ))}
          </div>

          {/* Mini funnel */}
          <div className={`${cardCls} p-4`}>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Campaign funnel</div>
            <div className="space-y-2.5">
              {funnel.map((f) => {
                const pct = metrics.people ? Math.round((f.n / metrics.people) * 100) : 0;
                return (
                  <div key={f.label}>
                    <div className="flex justify-between text-[11px] mb-1"><span className="text-gray-500">{f.label}</span><span className="text-gray-900 font-semibold">{f.n} · {pct}%</span></div>
                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full bg-[#48f4ad]" style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Grow your list — one clear flow */}
          <div className={`${cardCls} p-5`}>
            <div className="text-sm font-bold text-gray-900">Find more people to reach</div>
            <div className="text-[12px] text-gray-500 mt-0.5 mb-3">Describe who you&apos;re trying to reach, then hit Find leads. New people are added to your list automatically.</div>
            <textarea
              value={icpRules}
              onChange={(e) => setIcpRules(e.target.value)}
              className={`w-full ${inputCls} p-3 text-sm h-24 resize-none`}
              placeholder="e.g. Event producers and creative directors at experiential marketing agencies in the US."
            />
            <div className="flex items-center gap-2 flex-wrap mt-3">
              <button onClick={() => handleRun('discover', 'serper')} disabled={running} className="bg-[#48f4ad] hover:brightness-105 disabled:opacity-60 text-[#04231a] text-sm font-bold py-2.5 px-5 rounded-lg transition-all shadow-sm inline-flex items-center gap-1.5">
                <Icon name="sparkles" className="w-4 h-4" /> {running ? 'Finding…' : 'Find leads'}
              </button>
              <button onClick={() => setAdvancedOpen((v) => !v)} className="text-[12px] font-semibold text-gray-500 hover:text-gray-800 px-2 py-1">{advancedOpen ? 'Hide options' : 'More options'}</button>
            </div>
            {runMsg.type !== 'idle' && <div className={`text-[12px] font-medium mt-2.5 ${runMsg.type === 'err' ? 'text-rose-600' : runMsg.type === 'ok' ? 'text-emerald-700' : 'text-gray-500'}`}>{runMsg.text}</div>}

            {advancedOpen && (
              <div className="mt-4 pt-4 border-t border-gray-100 space-y-4">
                <div>
                  <div className="text-[12px] font-semibold text-gray-700 mb-1">Target specific companies</div>
                  <div className="text-[11px] text-gray-500 mb-1.5">Paste company websites or LinkedIn pages (one per line) to find people who work there.</div>
                  <textarea
                    value={targetLinksText}
                    onChange={(e) => setTargetLinksText(e.target.value)}
                    placeholder="https://www.linkedin.com/company/jack-morton/"
                    className={`w-full ${inputCls} p-2.5 text-xs h-16 resize-none`}
                  />
                  <button onClick={() => handleRun('target', 'serper')} disabled={running} className="mt-2 border border-gray-200 bg-white text-gray-700 text-xs font-semibold py-2 px-4 rounded-lg hover:bg-gray-50 disabled:opacity-50">Find people at these companies</button>
                </div>
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                  <div className="text-[12px] font-semibold text-amber-800">Verified-email finder</div>
                  <div className="text-[11px] text-amber-700 mt-0.5 mb-2">Pulls contacts with confirmed email addresses. Uses paid credits, so use it sparingly.</div>
                  <button onClick={() => handleRun('discover', 'apollo')} disabled={running} className="border border-amber-300 bg-white text-amber-800 text-xs font-semibold py-2 px-4 rounded-lg hover:bg-amber-100 disabled:opacity-50">Find verified-email leads</button>
                </div>
              </div>
            )}

            {sourceCounts.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Companies in your list</div>
                <div className="flex flex-wrap gap-1.5">
                  {sourceCounts.map(([name, n]) => (
                    <span key={name} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-gray-200 text-gray-600 bg-gray-50">{name}<span className="text-emerald-600">{n}</span></span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= PEOPLE ================= */}
      {activeTab === 'People' && (
        <div className="mx-4 sm:mx-8 mt-6 mb-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="relative w-full max-w-sm">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><Icon name="search" className="w-3.5 h-3.5" /></span>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, title, company, email, or tag…" className={`w-full ${inputCls} bg-white pl-8 pr-3 py-2 text-xs`} />
            </div>
            <div className="flex items-center gap-2 whitespace-nowrap">
              <button onClick={openFocus} className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-2 rounded-lg bg-[#48f4ad] text-[#04231a] hover:brightness-105 shadow-sm"><Icon name="play" className="w-3 h-3" />Fast queue</button>
              <span className="text-[11px] text-gray-400 font-medium">{filteredLeads.length} shown</span>
            </div>
          </div>

          {/* Sub-tabs — contacted people move to their own tab automatically */}
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-0.5">
            {([['Ready', 'To contact', toContactCount], ['Contacted', 'Contacted', contactedCount], ['All', 'All', active.length]] as ['Ready' | 'Contacted' | 'All', string, number][]).map(([key, label, count]) => (
              <button key={key} onClick={() => setPeopleFilter(key)} className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all inline-flex items-center gap-1.5 ${peopleFilter === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {label}<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${peopleFilter === key ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-500'}`}>{count}</span>
              </button>
            ))}
          </div>

          <div className={`${cardCls} overflow-hidden`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-gray-400 font-semibold tracking-wider uppercase text-[11px]">
                    <th className="px-4 py-3.5 w-8"><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} className="rounded border-gray-300 accent-[#059669] cursor-pointer" /></th>
                    <th className="px-4 py-3.5 w-72">Person</th>
                    <th className="px-4 py-3.5 w-40 hidden sm:table-cell">Company</th>
                    <th className="px-4 py-3.5 w-44">Status</th>
                    <th className="px-4 py-3.5 hidden md:table-cell">Why them</th>
                    <th className="px-4 py-3.5 text-right w-24 hidden lg:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredLeads.length === 0 && (
                    <tr><td colSpan={6} className="p-10 text-center text-gray-400 text-xs">No people match{q ? ` “${search}”` : ''}.</td></tr>
                  )}
                  {filteredLeads.map((lead) => {
                    const contacted = isContacted(lead.id);
                    const s = emailStatus(lead.email_confidence);
                    return (
                      <tr key={lead.id} onClick={() => setSelectedLead(lead)} className="hover:bg-gray-50 transition-colors cursor-pointer">
                        <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggleSelect(lead.id)} className="rounded border-gray-300 accent-[#059669] cursor-pointer" />
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-start gap-3.5">
                            <div className="w-9 h-9 rounded-full flex items-center justify-center font-medium text-gray-600 bg-gray-100 shrink-0 text-sm uppercase">{lead.company_name.charAt(0)}</div>
                            <div className="min-w-0">
                              <div className="font-semibold text-gray-900 text-sm flex items-center gap-1.5">
                                {lead.person_name}
                                {(lead.linkedin_url || lead.website_url)
                                  ? <a href={lead.linkedin_url || lead.website_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Open LinkedIn" className="inline-flex items-center justify-center bg-[#0A66C2] rounded text-[9px] font-serif px-1 text-white font-bold scale-90 origin-left hover:opacity-80">in</a>
                                  : <span className="inline-flex items-center justify-center bg-gray-100 border border-gray-200 rounded text-[9px] font-serif px-1 text-gray-400 font-bold scale-90 origin-left">in</span>}
                              </div>
                              <div className="text-gray-500 font-medium mt-0.5 leading-relaxed">{lead.decision_maker_title}</div>
                              <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
                                <span className="text-emerald-600 font-medium break-all">{lead.verified_email}</span>
                                <span className={`inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${s.pill}`}><Icon name={s.iconName} className="w-3 h-3 shrink-0" /> {s.text}</span>
                              </div>
                              {getMeta(lead.id).tags.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1.5">
                                  {getMeta(lead.id).tags.map((t) => <span key={t} className="bg-emerald-50 text-emerald-700 text-[9px] font-semibold px-1.5 py-0.5 rounded-full border border-emerald-100">{t}</span>)}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-gray-700 font-medium hidden sm:table-cell">{lead.company_name}</td>
                        <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                          {contacted ? (
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-600">
                              <span className="text-emerald-600">✓</span> {getStage(lead.id) === 'Contacted' ? 'Contacted' : getStage(lead.id)}
                              {lead.contacted_by && <span className="text-gray-400 font-medium">· {lead.contacted_by}</span>}
                            </span>
                          ) : (
                            <div className="flex flex-col items-start gap-1.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button onClick={() => quickCopyNote(lead)} title="Copy the personalized LinkedIn note (does not mark contacted)" className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"><Icon name="linkedin" className="w-3 h-3" /> Copy note</button>
                                {lead.verified_email && <button onClick={() => quickCopyEmail(lead)} title="Copy the personalized email opener (does not mark contacted)" className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"><Icon name="mail" className="w-3 h-3" /> Copy email</button>}
                              </div>
                              <button onClick={() => setStage(lead.id, 'Contacted')} title="Mark contacted — moves them to the Contacted tab" className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-[#48f4ad] text-[#04231a] hover:brightness-105 transition-all"><span>✓</span> Mark contacted</button>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3.5 hidden md:table-cell">
                          <div className="flex items-start gap-2 max-w-xl">
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded-md shrink-0 tracking-tight uppercase mt-0.5">{lead.fit_score} Fit</span>
                            <span className="text-gray-500 font-medium leading-relaxed block pl-1">{lead.buying_signal}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-right text-gray-400 font-medium tracking-tight hidden lg:table-cell">{(lead.created_at || '').slice(0, 10)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================= TEMPLATE (LinkedIn + Email dual sequence) ================= */}
      {activeTab === 'Messages' && (
        <div className="mx-4 sm:mx-8 mt-6 mb-8">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
            <div>
              <div className="text-sm font-bold text-gray-900">Your messages</div>
              <div className="text-[12px] text-gray-500 mt-0.5">Your outreach messages: a LinkedIn note, an intro email, and a Sales Navigator InMail for people you&apos;re not connected to. Green words like <span className="text-emerald-600 font-semibold">first name</span> and <span className="text-emerald-600 font-semibold">company</span> fill in automatically for each lead. Preview shows {sampleLead ? sampleLead.person_name : 'a sample lead'}.</div>
            </div>
            <button onClick={() => saveSequence(DEFAULT_SEQUENCE)} className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">Reset to default</button>
          </div>

          <div className="max-w-3xl mx-auto">
            {sequence.map((node, i) => {
              const kind: Channel = i === 0 ? 'linkedin' : i === 1 ? 'email' : 'inmail';
              const label = kind === 'linkedin' ? 'LinkedIn connection note' : kind === 'email' ? 'Intro email' : 'InMail — for people you’re not connected to';
              const bodyVal = kind === 'linkedin' ? node.linkedin : kind === 'email' ? node.email : node.inmail;
              const setBody = (v: string) => updateNode(i, kind === 'linkedin' ? { linkedin: v } : kind === 'email' ? { email: v } : { inmail: v });
              const chips: [string, string][] = [['{first_name}', 'First name'], ['{company}', 'Company'], ['{title}', 'Title']];
              return (
                <div key={node.key}>
                  <div className={`${cardCls} overflow-hidden`}>
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-gray-50">
                      <span className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black bg-[#48f4ad] text-[#04231a]"><Icon name={kind === 'linkedin' ? 'linkedin' : kind === 'email' ? 'mail' : 'send'} className="w-3.5 h-3.5" /></span>
                      <div className="text-sm font-bold text-gray-900">{label}</div>
                    </div>
                    <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div>
                        {kind !== 'linkedin' && (
                          <div className="mb-2">
                            <div className="text-[11px] font-semibold text-gray-500 mb-1">Subject line</div>
                            <input value={node.subject} onChange={(e) => updateNode(i, { subject: e.target.value })} className={`w-full ${inputCls} px-2.5 py-1.5 text-xs`} />
                          </div>
                        )}
                        <div className="text-[11px] font-semibold text-gray-500 mb-1">Message</div>
                        <textarea value={bodyVal} onChange={(e) => setBody(e.target.value)} className={`w-full ${inputCls} p-2.5 text-xs h-36 resize-none`} />
                        <div className="flex items-center gap-1.5 flex-wrap mt-2">
                          <span className="text-[10px] text-gray-400">Insert:</span>
                          {chips.map(([token, lbl]) => (
                            <button key={token} onClick={() => setBody((bodyVal ? bodyVal + ' ' : '') + token)} className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 hover:bg-emerald-100">+ {lbl}</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] font-semibold text-gray-500">Preview</span>
                          <button onClick={() => copy(renderFor(bodyVal, sampleLead))} className="text-[11px] font-semibold text-emerald-600 hover:underline">Copy</button>
                        </div>
                        {kind !== 'linkedin' && <div className="text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 mb-2"><span className="text-gray-400">Subject: </span><Highlight text={node.subject} /></div>}
                        <div className="text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-2.5 whitespace-pre-wrap min-h-[9rem] leading-relaxed">
                          <Highlight text={bodyVal} />
                        </div>
                      </div>
                    </div>
                  </div>
                  {i === 0 && (
                    <div className="flex flex-col items-center py-1">
                      <div className="w-px h-4 bg-emerald-200" />
                      <span className="w-6 h-6 rounded-full flex items-center justify-center bg-emerald-50 border border-emerald-200 text-emerald-600"><Icon name="down" className="w-3.5 h-3.5" /></span>
                      <div className="w-px h-4 bg-emerald-200" />
                    </div>
                  )}
                  {i === 1 && (
                    <div className="flex items-center gap-3 py-4">
                      <div className="h-px flex-1 bg-gray-200" />
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Or, if you&apos;re not connected — Sales Navigator InMail</span>
                      <div className="h-px flex-1 bg-gray-200" />
                    </div>
                  )}
                </div>
              );
            })}
            <div className="text-[11px] text-gray-400 mt-4 text-center">The LinkedIn note and email are used by &ldquo;Ready to send&rdquo; and the Fast queue. Use the InMail from a lead&apos;s details panel when you&apos;re not connected.</div>
          </div>
        </div>
      )}

      {/* ================= REVIEW ================= */}
      {activeTab === 'Review' && (() => {
        const deliverable = active.filter((l) => l.email_confidence === 'medium');
        const undeliverable = active.filter((l) => l.email_confidence === 'low');
        const noEmail = active.filter((l) => !l.verified_email || l.email_confidence === 'none');
        const ready = active.filter((l) => !isContacted(l.id));
        const attention = [...undeliverable, ...noEmail].filter((l, i, arr) => arr.findIndex((x) => x.id === l.id) === i);
        const total = active.length || 1;
        return (
          <div className="mx-4 sm:mx-8 mt-6 mb-8 space-y-4">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-5 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-emerald-700 font-bold">Ready to contact</div>
                <div className="text-4xl font-black text-gray-900 mt-1">{ready.length}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">active people not yet contacted</div>
              </div>
              <button onClick={() => { setActiveTab('People'); setPeopleFilter('Ready'); }} className="text-[11px] font-bold text-white bg-gray-900 hover:bg-black rounded-lg px-3 py-1.5">Work them →</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className={`${cardCls} p-4`}>
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Deliverability</div>
                {([['Verified (deliverable)', deliverable.length, 'bg-[#48f4ad]'], ['Undeliverable domain', undeliverable.length, 'bg-rose-400'], ['No email', noEmail.length, 'bg-gray-300']] as [string, number, string][]).map(([l, n, c]) => (
                  <div key={l} className="mb-2">
                    <div className="flex justify-between text-[11px] mb-1"><span className="text-gray-500">{l}</span><span className="text-gray-900 font-semibold">{n} · {Math.round((n / total) * 100)}%</span></div>
                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className={`h-full rounded-full ${c}`} style={{ width: `${Math.round((n / total) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
              <div className={`${cardCls} p-4`}>
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Pipeline snapshot</div>
                {([['Contacted', metrics.contacted], ['Connect accepted', metrics.accepted], ['Replied', metrics.replied]] as [string, number][]).map(([l, n]) => (
                  <div key={l} className="flex justify-between text-[12px] py-1.5 border-b border-gray-100"><span className="text-gray-500">{l}</span><span className="font-bold text-emerald-600">{n}</span></div>
                ))}
              </div>
            </div>
            {attention.length > 0 && (
              <div className={`${cardCls} p-4`}>
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Needs attention ({attention.length}) — bad or missing email</div>
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {attention.slice(0, 40).map((l) => (
                    <div key={l.id} onClick={() => setSelectedLead(l)} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50 cursor-pointer">
                      <div className="min-w-0"><div className="text-xs font-semibold text-gray-800 truncate">{l.person_name} <span className="text-gray-400 font-normal">· {l.company_name}</span></div><div className="text-[10px] text-gray-400 truncate">{l.verified_email || 'no email'}</div></div>
                      <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${emailStatus(l.email_confidence).pill}`}><Icon name={emailStatus(l.email_confidence).iconName} className="w-3 h-3 shrink-0" /> {emailStatus(l.email_confidence).text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ================= SETTINGS ================= */}
      {activeTab === 'Settings' && (
        <div className="mx-4 sm:mx-8 mt-6 mb-8 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className={`${cardCls} p-4 lg:col-span-2`}>
            <div className="text-sm font-bold text-gray-900 mb-1">Your account</div>
            <div className="text-[12px] text-gray-500 mb-3">Signed in as <span className="font-semibold text-gray-700">{authUser?.name}</span> ({authUser?.email}). Your name is stamped on every lead you contact, note you add, and sequence you push.</div>
            <div className="text-[12px] font-semibold text-gray-600 mb-1.5">Set your own password</div>
            <div className="flex gap-2 items-center flex-wrap">
              <input type="password" value={pwNew} autoComplete="new-password" onChange={(e) => { setPwNew(e.target.value); setPwMsg(null); }} placeholder="New password (8+ characters)" className={`${inputCls} px-3 py-2 text-sm w-full sm:w-64`} />
              <button onClick={changePassword} disabled={pwBusy || pwNew.length < 8} className="bg-gray-900 hover:bg-black disabled:opacity-40 text-white text-xs font-bold px-4 py-2 rounded-lg">{pwBusy ? 'Saving…' : 'Update password'}</button>
              {pwMsg && <span className={`text-[12px] font-medium ${pwMsg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>{pwMsg.text}</span>}
            </div>
          </div>
          <div className={`${cardCls} p-4 lg:col-span-2`}>
            <div className="text-sm font-bold text-gray-900 mb-1">What you offer</div>
            <div className="text-[12px] text-gray-500 mb-2">One or two sentences about what you do. The AI uses this to write your outreach.</div>
            <textarea value={senderPitch} onChange={(e) => savePitch(e.target.value)} placeholder="e.g. We build a photo/AR experience that makes live events more interactive and shareable." className={`w-full ${inputCls} p-2.5 text-sm h-20 resize-none`} />
          </div>
          <div className={`${cardCls} p-4 lg:col-span-2`}>
            <div className="text-sm font-bold text-gray-900 mb-1">Email</div>
            <div className="text-[12px] text-gray-500 mb-3">Where your &ldquo;Email&rdquo; buttons open, and the footer added to every email you send.</div>
            <div className="text-[12px] font-semibold text-gray-600 mb-1.5">Open emails in</div>
            <div className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-0.5 mb-1.5">
              {([['gmail', 'Gmail'], ['outlook', 'Outlook'], ['default', 'Mail app']] as ['gmail' | 'outlook' | 'default', string][]).map(([id, label]) => (
                <button key={id} onClick={() => saveMailClient(id)} className={`px-3 py-1 rounded-md text-[12px] font-semibold transition-all ${mailClient === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{label}</button>
              ))}
            </div>
            <div className="text-[11px] text-gray-400 mb-4">Gmail and Outlook open a compose window in your browser — pick one of these if clicking &ldquo;Email&rdquo; does nothing on your computer. &ldquo;Mail app&rdquo; uses your computer&apos;s default mail program.</div>
            <div className="text-[12px] font-semibold text-gray-600 mb-1.5">Email footer <span className="text-gray-400 font-normal">— added to the bottom of every email</span></div>
            <textarea value={emailFooter} onChange={(e) => saveEmailFooter(e.target.value)} className={`w-full ${inputCls} p-2.5 text-xs h-24 resize-none`} />
            <div className="text-[11px] text-gray-400 mt-1.5 leading-relaxed">US anti-spam law (CAN-SPAM) requires an opt-out and your physical mailing address in marketing emails. Replace the [brackets] with your details. <button onClick={() => saveEmailFooter(DEFAULT_FOOTER)} className="text-emerald-600 font-semibold hover:underline">Reset to default</button></div>
          </div>
          <div className={`${cardCls} p-4 lg:col-span-2`}>
            <div className="flex items-center gap-2 mb-1">
              <div className="text-sm font-bold text-gray-900">Email sequencer</div>
              {webhookUrl
                ? <span className="text-[10px] font-bold text-[#04231a] bg-[#48f4ad] rounded-full px-2 py-0.5 uppercase tracking-wide">Connected</span>
                : <span className="text-[10px] font-semibold text-gray-500 bg-gray-100 rounded-full px-2 py-0.5 uppercase tracking-wide">Optional</span>}
            </div>
            <div className="text-[12px] text-gray-500 mb-2">Send leads straight into your cold-email tool — no CSV downloads. Paste the webhook link from Zapier, Make, Instantly, or Smartlead once, and a <span className="font-semibold text-gray-700">⚡ Push to sequencer</span> button appears on every verified lead.</div>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => saveWebhookUrl(e.target.value)}
              placeholder="https://hooks.zapier.com/hooks/catch/…"
              className={`w-full ${inputCls} px-3 py-2 text-xs font-mono`}
            />
            <div className="text-[11px] text-gray-400 mt-1.5">Each push sends their name, title, company, verified email, and your personalized icebreaker + email draft. Clear the box to disconnect.</div>
          </div>
          <div className={`${cardCls} p-4`}>
            <div className="text-sm font-bold text-gray-900 mb-1">Daily goal</div>
            <div className="text-[13px] text-gray-800 font-semibold mb-2"><span className={sentToday >= dailyTarget ? 'text-rose-600' : 'text-emerald-600'}>{sentToday}</span> of {dailyTarget} sent today</div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] text-gray-500">People per day:</span>
              <input type="number" min={1} max={200} value={dailyTarget} onChange={(e) => saveDailyTarget(Number(e.target.value))} className={`w-16 ${inputCls} px-2 py-1 text-sm`} />
            </div>
            <div className="text-[12px] text-gray-500 leading-relaxed">Just a reminder to pace yourself — nothing stops you at this number. If you&apos;re sending <span className="font-semibold text-gray-700">LinkedIn invites</span>, keep it near 20/day (~100/week) so LinkedIn doesn&apos;t flag your account. <span className="font-semibold text-gray-700">Email</span> and <span className="font-semibold text-gray-700">Sales Navigator InMail</span> can safely go higher — InMail also lets you message people you&apos;re not connected to, using a separate monthly credit pool.</div>
          </div>
          <div className={`${cardCls} p-4`}>
            <div className="text-sm font-bold text-gray-900 mb-2">Your data</div>
            <button onClick={exportCsv} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-black text-white">Download leads (CSV)</button>
            <div className="text-[12px] text-gray-500 mt-2 leading-relaxed">Your leads are saved safely in the database. Tags, notes, and your messages are kept in this browser.</div>
          </div>
        </div>
      )}

      {/* ================= FLOATING AI COMMAND BAR ================= */}
      <div className="fixed bottom-0 inset-x-0 z-40 pointer-events-none px-4 pb-4">
        <div className="pointer-events-auto mx-auto max-w-2xl">
          {aiReply && (
            <div className="mb-2 rounded-2xl bg-white border border-gray-200 shadow-lg p-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-emerald-600"><Icon name="sparkles" className="w-4 h-4" /></span>
                <div className="flex-1 text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{aiReply}</div>
                <button onClick={() => setAiReply('')} className="shrink-0 text-gray-400 hover:text-gray-700 text-sm leading-none">✕</button>
              </div>
            </div>
          )}
          {toast && <div className="mb-2 text-center"><span className="inline-block text-[11px] font-semibold text-white bg-gray-900 rounded-full px-3 py-1.5 shadow-lg">{toast}</span></div>}
          <div className="flex items-center gap-2 rounded-full bg-white/90 backdrop-blur border border-gray-200 shadow-lg pl-4 pr-2 py-2">
            <Icon name="sparkles" className={`w-4 h-4 shrink-0 ${cmdBusy ? 'text-emerald-400 animate-pulse' : 'text-emerald-600'}`} />
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runCommand(); }}
              disabled={cmdBusy}
              placeholder={cmdBusy ? 'Claude is working…' : 'Ask Claude for help… e.g. “who should I contact first?”'}
              className="flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none disabled:opacity-60"
            />
            <button onClick={runCommand} disabled={cmdBusy} className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-bold text-white bg-gray-900 rounded-full px-3 py-1.5 hover:bg-black disabled:opacity-50">
              <Icon name="send" className="w-3 h-3" /> {cmdBusy ? 'Thinking…' : 'Run'}
            </button>
          </div>
        </div>
      </div>

      {/* ================= LEAD DETAIL DRAWER ================= */}
      {selectedLead && (
        <>
          <div className="fixed inset-0 bg-gray-900/20 backdrop-blur-sm z-40" onClick={() => setSelectedLead(null)} />
          <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white border-l border-gray-200 shadow-2xl z-50 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-sm font-bold text-gray-900">Lead details</h2>
              <button onClick={() => setSelectedLead(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">✕</button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 space-y-5">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center font-medium text-gray-600 bg-gray-100 text-lg uppercase shrink-0">{selectedLead.company_name.charAt(0)}</div>
                <div className="min-w-0">
                  <div className="font-bold text-gray-900 text-lg leading-tight">{selectedLead.person_name}</div>
                  <div className="text-gray-500 text-sm">{selectedLead.decision_maker_title}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full border ${emailStatus(selectedLead.email_confidence).pill}`}><Icon name={emailStatus(selectedLead.email_confidence).iconName} className="w-3 h-3 shrink-0" /> {emailStatus(selectedLead.email_confidence).text}</span>
                <select value={getStage(selectedLead.id)} onChange={(e) => setStage(selectedLead.id, e.target.value)} className={`text-[11px] font-bold rounded-lg px-2 py-1.5 border cursor-pointer focus:outline-none ${STAGE_STYLES[getStage(selectedLead.id)] || 'text-gray-600 bg-gray-50 border-gray-200'}`}>
                  {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={() => { copy(selectedLead.verified_email); flash('Email copied.'); }} className="text-[11px] font-semibold text-gray-600 border border-gray-200 bg-white rounded-lg px-2 py-1.5 hover:bg-gray-50">Copy email</button>
              </div>

              {/* Real send actions */}
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => quickSend(selectedLead)} className="text-[11px] font-bold text-[#04231a] bg-[#48f4ad] rounded-lg px-2.5 py-1.5 hover:brightness-105 inline-flex items-center gap-1.5"><Icon name="send" className="w-3 h-3" /> Ready to send</button>
                <button onClick={() => { copy(renderFor(inviteNode.linkedin, selectedLead)); window.open(linkedInHref(selectedLead), '_blank', 'noopener'); }} className="text-[11px] font-semibold border border-emerald-200 bg-emerald-50 text-emerald-700 rounded-lg px-2.5 py-1.5 hover:bg-emerald-100 inline-flex items-center gap-1.5"><Icon name="linkedin" className="w-3 h-3" /> Copy note &amp; open LinkedIn</button>
                {selectedLead.verified_email && <a href={emailUrl(selectedLead, emailNode)} target="_blank" rel="noreferrer" className="text-[11px] font-semibold border border-gray-200 text-gray-600 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 inline-flex items-center gap-1.5"><Icon name="mail" className="w-3 h-3" /> Email draft</a>}
                <button onClick={() => sendInmail(selectedLead)} title="Copy your InMail message and open their profile (Sales Navigator — works even if you're not connected)" className="text-[11px] font-semibold border border-sky-200 bg-sky-50 text-sky-700 rounded-lg px-2.5 py-1.5 hover:bg-sky-100 inline-flex items-center gap-1.5"><Icon name="send" className="w-3 h-3" /> Copy InMail</button>
                {webhookUrl && selectedLead.verified_email && (
                  <button onClick={() => pushToSequencer(selectedLead)} title="Send this lead into your connected email sequencer and mark Contacted" className="text-[11px] font-bold text-[#04231a] bg-[#48f4ad] rounded-lg px-2.5 py-1.5 hover:brightness-105 inline-flex items-center gap-1.5"><Icon name="zap" className="w-3 h-3" /> Push to sequencer</button>
                )}
              </div>

              {/* AI Outreach Composer */}
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">AI Outreach</div>
                  <button onClick={composeOutreach} disabled={composing} className="text-[11px] font-bold text-[#04231a] bg-[#48f4ad] rounded-lg px-2.5 py-1 disabled:opacity-50 hover:brightness-105 transition">{composing ? 'Drafting…' : outreach ? 'Regenerate' : 'Draft outreach'}</button>
                </div>
                {!outreach && !composing && <div className="text-[11px] text-gray-500 leading-relaxed">Generate a personalized LinkedIn note + email opener for {selectedLead.person_name.split(' ')[0] || 'this lead'}. You review and send it yourself.</div>}
                {composing && <div className="text-[11px] text-gray-500">Writing something personal…</div>}
                {outreach && (
                  <div className="space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">LinkedIn note <span className={`ml-1 ${outreach.note.length > 280 ? 'text-rose-600' : 'text-gray-400'}`}>{outreach.note.length}/280</span></span><button onClick={() => copy(outreach.note)} className="text-[10px] font-semibold text-emerald-600 hover:underline">Copy</button></div>
                      <textarea value={outreach.note} onChange={(e) => setOutreach({ ...outreach, note: e.target.value })} className={`w-full bg-white ${inputCls} p-2 text-xs h-20 resize-none`} />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Email opener</span><button onClick={() => copy(outreach.email)} className="text-[10px] font-semibold text-emerald-600 hover:underline">Copy</button></div>
                      <textarea value={outreach.email} onChange={(e) => setOutreach({ ...outreach, email: e.target.value })} className={`w-full bg-white ${inputCls} p-2 text-xs h-24 resize-none`} />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Why them</div>
                <p className="text-sm text-gray-700 leading-relaxed">{selectedLead.buying_signal}</p>
              </div>

              {/* Tags */}
              <div>
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Tags</div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {getMeta(selectedLead.id).tags.length === 0 && <span className="text-xs text-gray-400 italic">No tags yet</span>}
                  {getMeta(selectedLead.id).tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-emerald-100">{t}<button onClick={() => removeTag(selectedLead.id, t)} className="text-emerald-600 hover:text-emerald-800 leading-none">✕</button></span>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { addTag(selectedLead.id, tagInput); setTagInput(''); } }} placeholder="Add a tag, press Enter" className={`flex-1 bg-white ${inputCls} px-2.5 py-1.5 text-xs`} />
                  <button onClick={() => { addTag(selectedLead.id, tagInput); setTagInput(''); }} className="bg-gray-100 text-gray-700 text-xs font-semibold px-3 rounded-lg hover:bg-gray-200 border border-gray-200">Add</button>
                </div>
              </div>

              {/* Team notes thread — everyone's notes, with who wrote them */}
              <div>
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Team notes</div>
                <div className="space-y-2 mb-2 max-h-56 overflow-y-auto">
                  {leadNotes.length === 0 && <div className="text-xs text-gray-400 italic">No notes yet — be the first.</div>}
                  {leadNotes.map((n) => (
                    <div key={n.id} className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[11px] font-bold text-emerald-700">{n.author_name}</span>
                        <span className="text-[10px] text-gray-400">{new Date(n.created_at).toLocaleDateString()} {new Date(n.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                      </div>
                      <div className="text-xs text-gray-700 mt-0.5 whitespace-pre-wrap leading-relaxed">{n.body}</div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input value={noteInput} onChange={(e) => setNoteInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} placeholder="Add a note for the team…" className={`flex-1 bg-white ${inputCls} px-2.5 py-1.5 text-xs`} />
                  <button onClick={addNote} disabled={!noteInput.trim()} className="bg-gray-900 hover:bg-black disabled:opacity-40 text-white text-xs font-semibold px-3 rounded-lg">Post</button>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={() => { updateMeta(selectedLead.id, { rejected: !getMeta(selectedLead.id).rejected }); setSelectedLead(null); }} className="px-4 py-2.5 text-xs font-bold rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 w-full">
                  {getMeta(selectedLead.id).rejected ? 'Restore lead' : 'Reject lead'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ================= FAST QUEUE (focus mode) ================= */}
      {focusOpen && (() => {
        const cur = focusQueue[focusIdx];
        return (
          <>
            <div className="fixed inset-0 bg-gray-900/30 backdrop-blur-sm z-[70]" onClick={() => setFocusOpen(false)} />
            <div className="fixed inset-0 z-[71] flex items-center justify-center p-6 pointer-events-none">
              <div className="pointer-events-auto w-full max-w-xl rounded-2xl bg-white border border-gray-200 shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200">
                  <div className="text-sm font-bold text-gray-900">Fast queue {cur && <span className="text-gray-400 font-normal">— {focusIdx + 1} / {focusQueue.length}</span>}</div>
                  <div className="flex items-center gap-3">
                    <span className={`text-[11px] ${sentToday >= dailyTarget ? 'text-rose-600 font-semibold' : 'text-gray-400'}`}>{sentToday}/{dailyTarget} today</span>
                    <button onClick={() => setFocusOpen(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
                  </div>
                </div>
                {!cur ? (
                  <div className="p-10 text-center">
                    <div className="text-lg font-bold text-gray-900">{focusQueue.length === 0 ? 'No uncontacted people' : 'Queue complete'}</div>
                    <div className="text-xs text-gray-500 mt-1">{focusQueue.length === 0 ? 'Everyone is contacted or filtered — run a source to add more.' : 'You worked through every uncontacted person. Nice.'}</div>
                    <button onClick={() => setFocusOpen(false)} className="mt-4 text-[11px] font-bold text-white bg-gray-900 rounded-lg px-3 py-1.5">Close</button>
                  </div>
                ) : (
                  <div className="p-5">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-[#04231a] bg-[#48f4ad] shrink-0 text-sm uppercase">{cur.company_name.charAt(0)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-gray-900 text-base">{cur.person_name}</div>
                        <div className="text-xs text-gray-500">{cur.decision_maker_title} · {cur.company_name}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-[10px] font-black text-emerald-600">{cur.fit_score} FIT</span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${emailStatus(cur.email_confidence).pill}`}><Icon name={emailStatus(cur.email_confidence).iconName} className="w-3 h-3 shrink-0" /> {emailStatus(cur.email_confidence).text}</span>
                      </div>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-3 leading-relaxed bg-gray-50 border border-gray-200 rounded-lg p-2">{cur.buying_signal}</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold mb-1">LinkedIn invite</div>
                        <div className="text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-2 h-24 overflow-y-auto whitespace-pre-wrap"><Highlight text={renderFor(inviteNode.linkedin, cur)} /></div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Email</div>
                        <div className="text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-2 h-24 overflow-y-auto whitespace-pre-wrap"><Highlight text={renderFor(emailNode.email, cur)} /></div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mt-4">
                      <button onClick={() => focusEmail(cur)} disabled={!cur.verified_email} className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-[#48f4ad] text-[#04231a] hover:brightness-105 disabled:opacity-40 inline-flex items-center gap-1.5"><Icon name="mail" className="w-3 h-3" /> Email <span className="opacity-60 font-mono">e</span></button>
                      <button onClick={() => focusLinkedIn(cur)} className="text-[11px] font-bold px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 inline-flex items-center gap-1.5"><Icon name="external" className="w-3 h-3" /> LinkedIn <span className="opacity-60 font-mono">l</span></button>
                      <button onClick={() => { setStage(cur.id, 'Contacted'); focusNext(); }} className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-black">Done &amp; next <span className="opacity-60 font-mono">↵</span></button>
                      <button onClick={focusNext} className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100">Skip <span className="opacity-60 font-mono">s</span></button>
                      <button onClick={() => { updateMeta(cur.id, { rejected: true }); focusNext(); }} className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg text-rose-600 hover:bg-rose-50 ml-auto">Reject <span className="opacity-60 font-mono">r</span></button>
                    </div>
                    <div className="text-[10px] text-gray-400 mt-3">Keyboard: <span className="text-gray-600">E</span> email · <span className="text-gray-600">L</span> LinkedIn · <span className="text-gray-600">↵</span> done &amp; next · <span className="text-gray-600">S</span> skip · <span className="text-gray-600">R</span> reject · <span className="text-gray-600">Esc</span> close. You send manually — nothing is automated.</div>
                  </div>
                )}
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}
