import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.PROFILE_STATS_TOKEN;
if (!token) {
  throw new Error("Missing PROFILE_STATS_TOKEN. Add it as an Actions secret before running this workflow.");
}

const apiHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const now = new Date();
const from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
const to = now.toISOString();

const query = `
  query ProfileContributions($from: DateTime!, $to: DateTime!) {
    viewer {
      login
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalPullRequestReviewContributions
        totalRepositoriesWithContributedCommits
      }
    }
  }
`;

const graphResponse = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: { ...apiHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { from, to } }),
});
const graph = await graphResponse.json();
if (!graphResponse.ok || graph.errors) {
  throw new Error(`GitHub GraphQL request failed: ${JSON.stringify(graph.errors || graph)}`);
}

const { login, contributionsCollection: stats } = graph.data.viewer;
const repos = [];
for (let page = 1; ; page += 1) {
  const response = await fetch(
    `https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`,
    { headers: apiHeaders },
  );
  if (!response.ok) throw new Error(`Repository request failed: ${response.status}`);
  const batch = await response.json();
  repos.push(...batch);
  if (batch.length < 100) break;
}

const languages = new Map();
const eligibleRepos = repos.filter((repo) => !repo.fork && !repo.archived);
for (const repo of eligibleRepos) {
  const response = await fetch(repo.languages_url, { headers: apiHeaders });
  if (!response.ok) continue;
  const data = await response.json();
  for (const [name, bytes] of Object.entries(data)) {
    languages.set(name, (languages.get(name) || 0) + bytes);
  }
}

const xml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
}[character]));

const theme = {
  background: "#17151f",
  border: "#6958f5",
  title: "#f1f5f9",
  label: "#a7a2b5",
  value: "#2dd4bf",
  muted: "#6b7280",
};

function svgShell(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <rect width="100%" height="100%" rx="10" fill="${theme.background}" stroke="${theme.border}" stroke-width="2"/>
  ${body}
</svg>`;
}

function statRow(icon, label, value, y) {
  return `<text x="28" y="${y}" font-family="Arial, sans-serif" font-size="14" fill="${theme.value}">${icon}</text>
  <text x="52" y="${y}" font-family="Arial, sans-serif" font-size="14" font-weight="600" fill="${theme.label}">${xml(label)}</text>
  <text x="338" y="${y}" text-anchor="end" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="${theme.value}">${xml(value)}</text>`;
}

const year = now.getUTCFullYear();
const statsSvg = svgShell(400, 230, `
  <text x="28" y="38" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="${theme.title}">${xml(login)}'s GitHub activity</text>
  <text x="28" y="61" font-family="Arial, sans-serif" font-size="12" fill="${theme.muted}">Private-aware totals · ${year}</text>
  ${statRow("✦", "Commits this year", stats.totalCommitContributions.toLocaleString(), 96)}
  ${statRow("⑂", "Pull requests", stats.totalPullRequestContributions.toLocaleString(), 126)}
  ${statRow("◉", "Code reviews", stats.totalPullRequestReviewContributions.toLocaleString(), 156)}
  ${statRow("◌", "Issues opened", stats.totalIssueContributions.toLocaleString(), 186)}
  <circle cx="362" cy="125" r="27" fill="none" stroke="#a855f7" stroke-width="6"/>
  <text x="362" y="131" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#e9d5ff">GH</text>
`);

const sortedLanguages = [...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
const totalBytes = sortedLanguages.reduce((total, [, bytes]) => total + bytes, 0) || 1;
const palette = ["#ed8b00", "#6db33f", "#3178c6", "#a855f7", "#facc15"];
let offset = 28;
const segments = sortedLanguages.map(([name, bytes], index) => {
  const width = Math.max(4, Math.round((bytes / totalBytes) * 344));
  const segment = `<rect x="${offset}" y="69" width="${width}" height="12" rx="6" fill="${palette[index]}"/>`;
  offset += width;
  return segment;
}).join("");

const languageRows = sortedLanguages.map(([name, bytes], index) => {
  const percentage = ((bytes / totalBytes) * 100).toFixed(1);
  const column = index % 2;
  const row = Math.floor(index / 2);
  const x = column === 0 ? 28 : 205;
  const y = 118 + row * 34;
  return `<circle cx="${x}" cy="${y - 5}" r="6" fill="${palette[index]}"/>
    <text x="${x + 13}" y="${y}" font-family="Arial, sans-serif" font-size="13" fill="${theme.label}">${xml(name)} ${percentage}%</text>`;
}).join("");

const languagesSvg = svgShell(400, 230, `
  <text x="28" y="38" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="${theme.title}">Languages across authorized repositories</text>
  <text x="28" y="58" font-family="Arial, sans-serif" font-size="12" fill="${theme.muted}">By code volume · excludes forks and archived repositories</text>
  <rect x="28" y="69" width="344" height="12" rx="6" fill="#2a2634"/>
  ${segments}
  ${languageRows}
`);

await mkdir("assets", { recursive: true });
await writeFile("assets/profile-stats.svg", statsSvg);
await writeFile("assets/top-languages.svg", languagesSvg);
