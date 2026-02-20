interface Env {
  CACHE: KVNamespace;
  GITHUB_PAT: string;
  BASE_RPC: string;
  REGISTRY_ADDRESS: string;
  DAIMON_TOKEN: string;
}

interface Agent {
  name: string;
  wallet: string;
  slug: string | null;
  registeredAt: number;
  lastSeen: number;
  balanceEth: string | null;
  token: {
    address: string | null;
    symbol: string | null;
    priceUsd: string | null;
    change24h: string | null;
    dexUrl: string | null;
  };
  github: {
    issues: GithubIssue[];
    commits: GithubCommit[];
    focusMd: string | null;
    selfMd: string | null;
  };
}

interface GithubIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  created_at: string;
}

interface GithubCommit {
  sha: string;
  message: string;
  date: string;
}

interface NetworkResponse {
  agents: Agent[];
  cachedAt: number;
}

const CACHE_KEY = "network-data";
const CACHE_TTL = 300; // 5 minutes
const KNOWN_TOKENS: Record<string, { address: string; symbol: string }> = {
  "daimon111/daimon": {
    address: "0x98c51C8E958ccCD37F798b2B9332d148E2c05D57",
    symbol: "DAIMON",
  },
};

const REGISTRY_ABI = [
  {
    name: "getAll",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "repoUrl", type: "string" },
          { name: "wallet", type: "address" },
          { name: "name", type: "string" },
          { name: "registeredAt", type: "uint256" },
          { name: "lastSeen", type: "uint256" },
        ],
      },
    ],
  },
];

function encodeGetAll(): string {
  // keccak256("getAll()") first 4 bytes
  return "0x53ed5143";
}

function decodeGetAllResponse(hex: string): Array<{
  repoUrl: string;
  wallet: string;
  name: string;
  registeredAt: bigint;
  lastSeen: bigint;
}> {
  // Remove 0x prefix
  const data = hex.slice(2);
  if (data.length < 128) return [];

  // ABI decode: offset to array, then array length, then each tuple
  const arrayOffset = parseInt(data.slice(0, 64), 16) * 2;
  const arrayLength = parseInt(data.slice(arrayOffset, arrayOffset + 64), 16);

  const results: Array<{
    repoUrl: string;
    wallet: string;
    name: string;
    registeredAt: bigint;
    lastSeen: bigint;
  }> = [];

  // Each element in the array is referenced by an offset from the start of the array data
  const arrayDataStart = arrayOffset + 64;

  for (let i = 0; i < arrayLength; i++) {
    const elementOffset =
      parseInt(data.slice(arrayDataStart + i * 64, arrayDataStart + (i + 1) * 64), 16) * 2;
    const elementStart = arrayDataStart + elementOffset;

    // Tuple: offset_repoUrl, wallet, offset_name, registeredAt, lastSeen
    const repoUrlOffset = parseInt(data.slice(elementStart, elementStart + 64), 16) * 2;
    const wallet = "0x" + data.slice(elementStart + 64 + 24, elementStart + 128);
    const nameOffset = parseInt(data.slice(elementStart + 128, elementStart + 192), 16) * 2;
    const registeredAt = BigInt("0x" + data.slice(elementStart + 192, elementStart + 256));
    const lastSeen = BigInt("0x" + data.slice(elementStart + 256, elementStart + 320));

    // Decode repoUrl string
    const repoUrlLenStart = elementStart + repoUrlOffset;
    const repoUrlLen = parseInt(data.slice(repoUrlLenStart, repoUrlLenStart + 64), 16);
    const repoUrlHex = data.slice(repoUrlLenStart + 64, repoUrlLenStart + 64 + repoUrlLen * 2);
    const repoUrl = hexToString(repoUrlHex);

    // Decode name string
    const nameLenStart = elementStart + nameOffset;
    const nameLen = parseInt(data.slice(nameLenStart, nameLenStart + 64), 16);
    const nameHex = data.slice(nameLenStart + 64, nameLenStart + 64 + nameLen * 2);
    const name = hexToString(nameHex);

    results.push({ repoUrl, wallet, name, registeredAt, lastSeen });
  }

  return results;
}

function hexToString(hex: string): string {
  let str = "";
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  return str;
}

function extractSlug(repoUrl: string): string | null {
  const m = repoUrl.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)/);
  return m ? m[1].replace(/\.git$/, "") : null;
}

async function fetchRegistryAgents(env: Env): Promise<
  Array<{
    repoUrl: string;
    wallet: string;
    name: string;
    registeredAt: bigint;
    lastSeen: bigint;
  }>
> {
  const resp = await fetch(env.BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: env.REGISTRY_ADDRESS, data: encodeGetAll() }, "latest"],
    }),
  });

  const json = (await resp.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  if (!json.result || json.result === "0x") return [];

  return decodeGetAllResponse(json.result);
}

async function fetchGithubData(
  slug: string,
  pat: string
): Promise<{
  issues: GithubIssue[];
  commits: GithubCommit[];
  focusMd: string | null;
  selfMd: string | null;
}> {
  const headers = {
    Authorization: `token ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "daimon-network-api",
  };

  const [issuesRes, commitsRes, focusRes, selfRes] = await Promise.allSettled([
    fetch(`https://api.github.com/repos/${slug}/issues?state=all&per_page=10&sort=updated`, {
      headers,
    }),
    fetch(`https://api.github.com/repos/${slug}/commits?per_page=10`, { headers }),
    fetch(`https://raw.githubusercontent.com/${slug}/main/memory/focus.md`),
    fetch(`https://raw.githubusercontent.com/${slug}/main/memory/self.md`),
  ]);

  const issues: GithubIssue[] = [];
  if (issuesRes.status === "fulfilled" && issuesRes.value.ok) {
    const data = (await issuesRes.value.json()) as Array<{
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      created_at: string;
    }>;
    for (const issue of data) {
      issues.push({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map((l) => l.name),
        created_at: issue.created_at,
      });
    }
  }

  const commits: GithubCommit[] = [];
  if (commitsRes.status === "fulfilled" && commitsRes.value.ok) {
    const data = (await commitsRes.value.json()) as Array<{
      sha: string;
      commit: { message: string; author: { date: string } };
    }>;
    for (const c of data) {
      commits.push({
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split("\n")[0],
        date: c.commit.author.date,
      });
    }
  }

  let focusMd: string | null = null;
  if (focusRes.status === "fulfilled" && focusRes.value.ok) {
    focusMd = await focusRes.value.text();
  }

  let selfMd: string | null = null;
  if (selfRes.status === "fulfilled" && selfRes.value.ok) {
    selfMd = await selfRes.value.text();
  }

  return { issues, commits, focusMd, selfMd };
}

async function fetchTokenState(
  slug: string
): Promise<{ address: string; symbol: string } | null> {
  if (KNOWN_TOKENS[slug]) return KNOWN_TOKENS[slug];
  try {
    const resp = await fetch(
      `https://raw.githubusercontent.com/${slug}/main/memory/state.json`
    );
    if (!resp.ok) return null;
    const state = (await resp.json()) as {
      token?: { address?: string; symbol?: string };
    };
    if (state.token?.address) {
      return {
        address: state.token.address,
        symbol: state.token.symbol || "TOKEN",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchDexPrices(
  tokenAddresses: string[]
): Promise<Record<string, { priceUsd: string; change24h: string | null; dexUrl: string | null }>> {
  const prices: Record<string, { priceUsd: string; change24h: string | null; dexUrl: string | null }> = {};
  if (tokenAddresses.length === 0) return prices;

  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddresses.slice(0, 30).join(",")}`
    );
    const data = (await resp.json()) as {
      pairs?: Array<{
        baseToken: { address: string };
        priceUsd: string;
        priceChange?: { h24?: number };
        url?: string;
      }>;
    };
    if (data.pairs) {
      for (const pair of data.pairs) {
        const addr = pair.baseToken.address.toLowerCase();
        if (!prices[addr]) {
          prices[addr] = {
            priceUsd: pair.priceUsd,
            change24h:
              pair.priceChange?.h24 != null
                ? String(pair.priceChange.h24)
                : null,
            dexUrl: pair.url || null,
          };
        }
      }
    }
  } catch {
    // ignore
  }
  return prices;
}

async function fetchWalletBalance(rpcUrl: string, wallet: string): Promise<string | null> {
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_getBalance",
        params: [wallet, "latest"],
      }),
    });
    const data = (await resp.json()) as { result?: string };
    if (data.result) {
      const wei = parseInt(data.result, 16);
      return (wei / 1e18).toFixed(4);
    }
  } catch {
    // ignore
  }
  return null;
}

async function buildNetworkData(env: Env): Promise<NetworkResponse> {
  let registryAgents: Awaited<ReturnType<typeof fetchRegistryAgents>>;
  try {
    registryAgents = await fetchRegistryAgents(env);
  } catch {
    return { agents: [], cachedAt: Date.now() };
  }

  const agents: Agent[] = await Promise.all(
    registryAgents.map(async (raw) => {
      const slug = extractSlug(raw.repoUrl);

      // Fetch token info
      const tokenInfo = slug ? await fetchTokenState(slug) : null;

      // Fetch github data (only if slug exists and we have a PAT)
      const github =
        slug && env.GITHUB_PAT
          ? await fetchGithubData(slug, env.GITHUB_PAT)
          : { issues: [], commits: [], focusMd: null, selfMd: null };

      return {
        name: raw.name,
        wallet: raw.wallet,
        slug,
        registeredAt: Number(raw.registeredAt),
        lastSeen: Number(raw.lastSeen),
        balanceEth: null as string | null, // filled in after balance fetch
        token: {
          address: tokenInfo?.address || null,
          symbol: tokenInfo?.symbol || null,
          priceUsd: null as string | null, // filled in after dex fetch
          change24h: null as string | null,
          dexUrl: null as string | null,
        },
        github,
      };
    })
  );

  // Batch fetch all token prices + wallet balances in parallel
  const tokenAddresses = agents
    .filter((a) => a.token.address)
    .map((a) => a.token.address as string);

  const [prices, ...balances] = await Promise.all([
    fetchDexPrices(tokenAddresses),
    ...agents.map((a) => fetchWalletBalance(env.BASE_RPC, a.wallet)),
  ]);

  // Assign prices and balances
  for (let i = 0; i < agents.length; i++) {
    agents[i].balanceEth = balances[i];
    if (agents[i].token.address) {
      const priceData = prices[agents[i].token.address!.toLowerCase()];
      if (priceData) {
        agents[i].token.priceUsd = priceData.priceUsd;
        agents[i].token.change24h = priceData.change24h;
        agents[i].token.dexUrl = priceData.dexUrl;
      }
    }
  }

  return { agents, cachedAt: Date.now() };
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/network" && request.method === "GET") {
      // Check cache
      const cached = await env.CACHE.get(CACHE_KEY);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60",
            ...corsHeaders(),
          },
        });
      }

      try {
        const data = await buildNetworkData(env);
        const json = JSON.stringify(data);

        // Store in KV with TTL
        await env.CACHE.put(CACHE_KEY, json, { expirationTtl: CACHE_TTL });

        return new Response(json, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60",
            ...corsHeaders(),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(),
          },
        });
      }
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    return new Response("not found", { status: 404, headers: corsHeaders() });
  },
};
