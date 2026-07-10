/**
 * Gen-video community intelligence products.
 *
 * Queries a public PostgREST endpoint mirroring a Discord community where
 * practitioners discuss generative video/image tooling (Wan, LTX, ComfyUI,
 * training, etc.). Data is live and community-authored.
 *
 * Returns synthesized knowledge — settings, tips, gotchas, workflow links —
 * never raw PII. Source attributed as "community practitioners".
 */

const POSTGREST_URL = "https://ujlwuvkrxlvoswwkerdf.supabase.co/rest/v1/message_feed";
const POSTGREST_KEY = "sb_publishable_O38oPBafrBoFrpi_rlWJvA_UJrulFsx";

/** Model → channel routing map */
const MODEL_CHANNELS: Record<string, string[]> = {
  wan: ["wan_chatter", "wan_comfyui", "wan_gens", "wan_resources", "resources"],
  ltx: ["ltx_chatter", "ltx_resources", "ltx_gens", "ltx_training", "resources"],
  comfyui: ["comfyui", "wan_comfyui", "resources"],
  flux: ["flux_training", "comfyui", "resources"],
  training: ["training_control_loras", "ltx_training", "wan_training", "comfyui"],
  general: ["daily_summaries", "chatter", "resources"],
};

/** Topic → search terms for targeted retrieval */
const TOPIC_TERMS: Record<string, string[]> = {
  settings: ["cfg", "steps", "denoise", "resolution", "fps", "sampler"],
  training: ["lora", "train", "rank", "alpha", "musubi", "ai-toolkit"],
  workflow: ["workflow", "node", "json", "pipeline"],
  gotcha: ["error", "bug", "fix", "artifact", "crash", "workaround"],
  performance: ["fp8", "int4", "quantiz", "vram", "speed", "optimize"],
};

interface FeedMessage {
  content: string;
  author_name: string | null;
  channel_name: string;
  created_at: string;
  message_id: number;
}

async function queryFeed(
  params: Record<string, string>,
  limit: number = 30,
): Promise<FeedMessage[]> {
  const qs = new URLSearchParams(params);
  const url = `${POSTGREST_URL}?${qs.toString()}&limit=${limit}&order=created_at.desc`;
  const resp = await fetch(url, {
    headers: {
      apikey: POSTGREST_KEY,
      Authorization: `Bearer ${POSTGREST_KEY}`,
    },
  });
  if (!resp.ok) {
    throw new Error(`PostgREST ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as FeedMessage[];
}

/** Synthesize community knowledge for a model/topic query. */
export async function genVideoIntel(query: string, model?: string): Promise<unknown> {
  const modelKey = model?.toLowerCase().trim() ?? "";
  const channels = MODEL_CHANNELS[modelKey] ?? ["daily_summaries", "wan_chatter", "ltx_chatter", "resources"];
  const channelFilter = `in.(${channels.join(",")})`;

  // 1. Search for the query term across relevant channels (last 180 days)
  const searchDate = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const term = query.replace(/[*()]/g, "").trim() || "best practices";

  let results: FeedMessage[] = [];
  try {
    results = await queryFeed(
      {
        channel_name: channelFilter,
        content: `ilike.*${encodeURIComponent(term)}*`,
        created_at: `gte.${searchDate}`,
        select: "content,author_name,channel_name,created_at,message_id",
      },
      40,
    );
  } catch {
    // Fallback: try daily_summaries only
    results = await queryFeed(
      {
        channel_name: "eq.daily_summaries",
        content: `ilike.*${encodeURIComponent(term)}*`,
        created_at: `gte.${searchDate}`,
        select: "content,author_name,channel_name,created_at,message_id",
      },
      20,
    );
  }

  // 2. Always include recent daily summaries as context
  let summaries: FeedMessage[] = [];
  try {
    summaries = await queryFeed(
      {
        channel_name: "eq.daily_summaries",
        created_at: `gte.${searchDate}`,
        select: "content,created_at",
      },
      5,
    );
  } catch {}

  // 3. Filter for substance and deduplicate
  const seen = new Set<number>();
  const substantial = results
    .filter((m) => {
      if (seen.has(m.message_id)) return false;
      seen.add(m.message_id);
      return m.content?.length >= 40;
    })
    .slice(0, 25);

  // 4. Build response — excerpts only, attributed by display name
  return {
    query,
    model: modelKey || "all",
    result_count: substantial.length,
    recent_summaries: summaries.map((s) => ({
      date: s.created_at?.slice(0, 10),
      excerpt: s.content?.slice(0, 500),
    })),
    community_knowledge: substantial.map((m) => ({
      author: m.author_name ?? "community",
      channel: m.channel_name,
      date: m.created_at?.slice(0, 10),
      excerpt: m.content.slice(0, 350),
    })),
    source: "Community practitioners via public PostgREST feed",
    note: "Settings and techniques are community-sourced. Verify against model docs before production use.",
  };
}

/** Look up recommended settings for a specific model + task. */
export async function modelSettingsLookup(
  model: string,
  task?: string,
): Promise<unknown> {
  const modelKey = model.toLowerCase().trim();
  const channels = MODEL_CHANNELS[modelKey] ?? MODEL_CHANNELS.general;
  const channelFilter = `in.(${channels.join(",")})`;

  // Targeted settings-term search
  const settingsTerms = task
    ? [task.toLowerCase().replace(/[()]/g, "")]
    : TOPIC_TERMS.settings;
  const searchDate = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  let allResults: FeedMessage[] = [];
  for (const term of settingsTerms.slice(0, 3)) {
    try {
      const batch = await queryFeed(
        {
          channel_name: channelFilter,
          content: `ilike.*${encodeURIComponent(term)}*`,
          created_at: `gte.${searchDate}`,
          select: "content,author_name,channel_name,created_at,message_id",
        },
        30,
      );
      allResults = allResults.concat(batch);
    } catch {}
  }

  // Deduplicate and score for settings content
  const seen = new Set<number>();
  const scored = allResults
    .filter((m) => {
      if (seen.has(m.message_id)) return false;
      seen.add(m.message_id);
      return m.content?.length >= 30;
    })
    .map((m) => {
      let score = 0;
      const lower = m.content.toLowerCase();
      if (/(?:cfg|guidance)[\s:=]+\d/i.test(lower)) score += 3;
      if (/steps?[\s:=]+\d/i.test(lower)) score += 3;
      if (/rank[\s:=]+\d/i.test(lower)) score += 2;
      if (/(?:lr|learning.?rate)[\s:=]+/i.test(lower)) score += 2;
      if (/\d{3,4}\s*[x×]\s*\d{3,4}/i.test(lower)) score += 2;
      if (/\bfp8\b|\bint4\b|\bint8\b|quantiz/i.test(lower)) score += 1;
      if (/denoise[\s:=]+/i.test(lower)) score += 1;
      if (/fps[\s:=]+\d/i.test(lower)) score += 1;
      if (/(?:github|huggingface|civitai)\.[a-z]+\//i.test(lower)) score += 1;
      if (m.content.length > 100 && m.content.length < 800) score += 1;
      return { msg: m, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  return {
    model: modelKey,
    task: task ?? "general",
    settings_discussions: scored.map(({ msg, score }) => ({
      author: msg.author_name ?? "community",
      channel: msg.channel_name,
      date: msg.created_at?.slice(0, 10),
      relevance_score: score,
      excerpt: msg.content.slice(0, 400),
    })),
    source: "Community practitioners via public PostgREST feed",
    note: "These are community-sourced settings recommendations, not official model defaults. Test before production use.",
  };
}
