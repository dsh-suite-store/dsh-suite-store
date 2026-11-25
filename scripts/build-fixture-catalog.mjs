/**
 * Builds a `format: 1` catalog index from the public awesome-dsh-plugin
 * directory snapshot.
 *
 * This is the data-repository job described in §5.2/§5.3 (`dsh-suite-store-catalog`),
 * run offline against a snapshot so the 0.1.0 smoke test has real bytes with
 * real npm specs instead of invented ones.
 *
 * Two rules from the spec are enforced here rather than trusted:
 *
 * - **A member must be installable.** §5.4 says every member must hit the
 *   directory; this script tightens that to "has an npm name and a version",
 *   because a GitHub-only member is a different install path and would make
 *   the smoke test prove nothing about the normal one (G5 in the spec checks
 *   the looser rule).
 * - **`spec` is the executable form; `id` is the stable one** (§5.5). The id is
 *   `npm:<package name>` without a version, the spec pins the version the
 *   directory snapshot recorded, so a run today installs exactly what the
 *   bundle author saw.
 *
 * Usage: node scripts/build-fixture-catalog.mjs <snapshot.json> <out.json>
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const [, , snapshotPath, outPath] = process.argv
if (snapshotPath === undefined || outPath === undefined) {
  console.error('usage: build-fixture-catalog.mjs <snapshot.json> <out.json>')
  process.exit(2)
}

const snapshot = JSON.parse(await readFile(resolve(snapshotPath), 'utf8'))
const byNpm = new Map()
for (const plugin of snapshot.plugins) {
  if (typeof plugin.npm !== 'string' || plugin.npm === '') continue
  if (typeof plugin.version !== 'string' || plugin.version === '') continue
  byNpm.set(plugin.npm, plugin)
}

/** Every installable entry for a package name, or a hard failure. */
function member(npm, role) {
  const plugin = byNpm.get(npm)
  if (plugin === undefined) throw new Error(`no installable directory entry for ${npm} (bundle: ${role})`)
  return {
    // `key` is the member's stable slot name INSIDE its bundle (§5.2), and it
    // is what the host reports back in `installed[bundleId]`. It is not the
    // package name: one suite can list two panes of the same package, and a
    // package rename must not orphan the key.
    key: role,
    name: plugin.name,
    id: `npm:${npm}`,
    version: plugin.version,
    pinned: true,
    spec: `npm:${npm}@${plugin.version}`,
    capabilities: plugin.capabilities ?? [],
  }
}

/**
 * The curated suites.
 *
 * Deliberately small and boring: these exist to exercise the install path end
 * to end (serial members, provenance, partial failure, uninstall preview),
 * not to be a real curation programme. Each name is a job a person might
 * have, which is the shape §3 argues the product is for.
 */
const SUITES = [
  {
    id: 'daily-driver',
    title: { zh: '日常驾驶舱', en: 'Daily driver' },
    summary: {
      zh: '会话上下文、用量计费、技能面板、Git 图谱与远程网页界面 —— 每天打开就能用的那一层。',
      en: 'Session context, usage metering, a skill panel, a git graph and the remote web UI — the layer you use every day.',
    },
    primary: 'getting-started',
    secondary: 'daily-driver',
    tags: ['context', 'metering', 'git', 'remote'],
    readme: {
      zh: '这一套解决的是「每天都要用，但每次都要重新配」的问题。会话上下文让你在长对话里还能找回两小时前的那句话；用量计表把 token 花在哪了摆出来；技能面板把你能调用的能力列成一排；Git 图谱把改动画成图；远程网页界面让你换台机器也能接着干。\n\n五个插件互不依赖，但装在一起时它们共享同一份会话记录，所以信息只需要说一次。',
      en: 'This suite solves the thing you use every day and reconfigure every day. Session context lets you find the sentence from two hours ago; the cost meter shows where the tokens went; the skill panel lays your callable abilities out in a row; the git graph draws the changes; and the remote web UI lets you pick up where you left off on another machine.\n\nNone of the five depends on another, but installed together they share one session record, so you only say things once.',
    },
    roles: {
      context: {
        zh: '长会话不会忘记开头说过什么，压缩后仍能取回原文。',
        en: 'Long conversations keep their opening; compressed turns stay retrievable.',
      },
      cost: {
        zh: '按会话、按模型统计用量与花费，随时知道这一轮花了多少。',
        en: 'Usage and spend per session and per model, so you know what a turn cost.',
      },
      skills: {
        zh: '把已安装的技能列成一栏，直接挑一个用。',
        en: 'Lists the skills you have installed so you can pick one directly.',
      },
      'git-graph': {
        zh: '把仓库的分支与提交画成图，不必开终端。',
        en: 'Draws branches and commits as a graph, without a terminal.',
      },
      remote: {
        zh: '从另一台机器的浏览器接入同一个会话。',
        en: 'Reach the same session from a browser on another machine.',
      },
    },
    members: [
      ['billion-context', 'context'],
      ['dsh-cost-meter', 'cost'],
      ['@linxin666/dsh-client-ui-skill-explorer', 'skills'],
      ['@linxin666/dsh-client-ui-git-graph', 'git-graph'],
      ['@linxin666/dsh-remote-web-ui', 'remote'],
    ],
  },
  {
    id: 'security-audit',
    title: { zh: '安全审计台', en: 'Security audit desk' },
    summary: {
      zh: '命令安全网、API 中继审计、自动代码评审 —— 把「这个改动敢不敢上」这件事变成一条流水线。',
      en: 'A command safety net, relay auditing and automatic review — turn "should I ship this" into a pipeline.',
    },
    primary: 'security-audit',
    secondary: 'command-guard',
    tags: ['safety', 'audit', 'review'],
    readme: {
      zh: '「这个改动敢不敢上」通常靠一个人的信心回答。这一套把它变成三步：安全网在你敲下危险命令时先拦一次；中继审计记录每一次模型调用去了哪；自动评审在你提交前把改动读一遍并说出担心的地方。\n\n三者都不阻止你做任何事 —— 它们只负责让后果在你按下回车之前可见。',
      en: '"Should I ship this" is usually answered by one person\'s confidence. This suite makes it three steps: the safety net intercepts the destructive command before it runs, the relay audit records where every model call went, and automatic review reads the diff before you commit and says what worries it.\n\nNone of the three stops you from doing anything — they only make the consequence visible before you press enter.',
    },
    roles: {
      'safety-net': {
        zh: '危险的 shell 命令先被截停，确认后才执行。',
        en: 'Destructive shell commands are held for confirmation before they run.',
      },
      'relay-audit': {
        zh: '记录每一次模型与工具调用的去向与耗时。',
        en: 'Records where each model and tool call went, and how long it took.',
      },
      'auto-review': {
        zh: '提交前自动读一遍改动，指出可疑之处。',
        en: 'Reads the diff before you commit and names what looks wrong.',
      },
    },
    members: [
      ['cc-safety-net', 'safety-net'],
      ['dsh-api-relay-audit', 'relay-audit'],
      ['dsh-auto-review', 'auto-review'],
    ],
  },
  {
    id: 'research-notes',
    title: { zh: '研究与笔记', en: 'Research and notes' },
    summary: {
      zh: '知识库、办公文档、行业调研与网页检索 —— 从「查一下」到「写成文档」的一条链。',
      en: 'A knowledge base, office documents, industry research and web search — from "look it up" to "write it down".',
    },
    primary: 'academic-research',
    secondary: 'deep-research',
    tags: ['knowledge', 'office', 'search'],
    readme: {
      zh: '调研的麻烦不在查，而在查完之后东西散在十几处。这一套把链路接起来：网页检索负责找到；行业调研把找到的整理成有结构的材料；知识库把材料收成一份随时可查的底稿；办公文档导出把底稿变成能发出去的表格与文档。\n\n四个插件各自都能单独用，串起来的时候你只在最后一步动一次手。',
      en: 'The hard part of research is not looking things up — it is that afterwards the pieces are in a dozen places. This suite connects the chain: web search finds it, industry research turns it into structured material, the knowledge base keeps that as a draft you can always ask again, and office export turns the draft into a spreadsheet or document you can send.\n\nEach of the four stands alone; joined up, you touch the work once, at the end.',
    },
    roles: {
      knowledge: {
        zh: '把资料收成可检索的底稿，下次直接问。',
        en: 'Keeps material as a searchable draft you can ask again later.',
      },
      office: {
        zh: '读写 xlsx / docx / pptx，结论直接落到文件里。',
        en: 'Reads and writes xlsx / docx / pptx so conclusions land in a file.',
      },
      industry: {
        zh: '按行业与主题组织调研，产出有结构的报告。',
        en: 'Organises research by industry and theme into a structured report.',
      },
      search: {
        zh: '检索网页并取回正文，作为后续材料。',
        en: 'Searches the web and fetches the page body as material.',
      },
    },
    members: [
      ['@eduwork/dsh-knowledge-studio', 'knowledge'],
      ['dsh-univer-office', 'office'],
      ['dsh-industry-research', 'industry'],
      ['dsh-free-search', 'search'],
    ],
  },
  {
    id: 'creative-workbench',
    title: { zh: '创作工作台', en: 'Creative workbench' },
    summary: {
      zh: '图像生成、小说写作、绘图与视频分镜 —— 需要「先生成一版看看」的时候。',
      en: 'Image generation, long-form writing, diagrams and storyboards — for when you need a first draft to look at.',
    },
    primary: 'design-creative',
    secondary: 'image-gen',
    tags: ['image', 'writing', 'diagram'],
    readme: {
      zh: '创作最难的是第一步：先生成出一版东西来看着。这一套四个插件分别覆盖四种第一版 —— 一张图、一章小说、一张架构图、一串分镜。它们共同的用法是「快速看到可能性」，而不是「一次就做完」。\n\n如果你只是在找灵感，这四个可以互相替换；如果你在做完整的产出，它们各自都能接着往下改。',
      en: 'The hardest part of making something is the first version you can look at. The four plugins here cover four kinds of first draft — an image, a chapter, an architecture diagram, a storyboard. They share one use: seeing a possibility quickly, not finishing it in one go.\n\nIf you are looking for a direction, any one of them substitutes for the others; if you are producing something real, each one takes the next step.',
    },
    roles: {
      'image-gen': {
        zh: '用一句话生成图片，也可以基于现有图改。',
        en: 'Generates an image from one sentence, or edits an existing one.',
      },
      novel: {
        zh: '长文写作：设定、大纲、章节，保持前后一致。',
        en: 'Long-form writing — premise, outline, chapters — staying consistent.',
      },
      diagram: {
        zh: '把一段描述画成可编辑的流程图与架构图。',
        en: 'Turns a description into an editable diagram or architecture sketch.',
      },
      storyboard: {
        zh: '把一段脚本拆成分镜，逐格配画面说明。',
        en: 'Breaks a script into shots, each with its own visual direction.',
      },
    },
    members: [
      ['dsh-image-gen', 'image-gen'],
      ['@ethanyoq/dsh-ai-novel-writer', 'novel'],
      ['@next-ai-drawio/dsh', 'diagram'],
      ['dsh-video-storyboard', 'storyboard'],
    ],
  },
  {
    id: 'windows-companion',
    title: { zh: 'Windows 伴侣', en: 'Windows companion' },
    summary: {
      zh: 'WSL 桥接、Windows 工具集与工作区选择器 —— 一台机器两个世界时的胶水。',
      en: 'A WSL bridge, a Windows toolkit and a workspace picker — the glue for one machine, two worlds.',
    },
    primary: 'remote-wsl',
    secondary: 'wsl-interop',
    tags: ['wsl', 'windows', 'interop'],
    readme: {
      zh: '在 Windows 上跑开发，一直有两个世界的缝：命令行在 WSL 里，文件在 C 盘里，剪贴板两边不通。这一套补上这几道缝：WSL 工具让命令在最合适的那一侧执行；Windows 工具集负责注册表、服务和快捷方式；桥接器把路径、剪贴板和端口在两边对齐。\n\n三个插件装完不需要配置 —— 它们自己判断当前在哪一侧。',
      en: 'Developing on Windows always has seams between two worlds: the shell is in WSL, the files are on C:, and the clipboard does not cross. This suite closes those seams: the WSL tool runs a command on whichever side is right, the Windows toolkit handles the registry, services and shortcuts, and the bridge lines up paths, clipboard and ports across both.\n\nNone of the three needs configuring after install — each works out which side it is on.',
    },
    roles: {
      wsl: {
        zh: '在 WSL 与 Windows 之间选对那一侧执行命令。',
        en: 'Runs the command on the right side of WSL and Windows.',
      },
      'win-tools': {
        zh: '注册表、服务、快捷方式与计划任务的原生操作。',
        en: 'Native registry, services, shortcuts and scheduled tasks.',
      },
      'wsl-bridge': {
        zh: '对齐两侧的路径、剪贴板与端口转发。',
        en: 'Lines up paths, clipboard and port forwarding across both sides.',
      },
    },
    members: [
      ['dsh-wsl-tool', 'wsl'],
      ['dsh-win-toolkit', 'win-tools'],
      ['dsh-wsl-bridge', 'wsl-bridge'],
    ],
  },
]

/** Union of the directory's capability words, for the card-level warning. */
function capabilitySummary(members) {
  const seen = new Set()
  for (const entry of members) for (const capability of entry.capabilities) seen.add(capability)
  return [...seen].sort()
}

/**
 * The detail document's `{ tag, sources }` list.
 *
 * Built from the same per-plugin capability words the card summarises, so the
 * two can never disagree about what a bundle touches: the card says "this
 * bundle wants these", the sheet says "…and here is who wants them".
 */
function capabilityList(members) {
  const byTag = new Map()
  for (const entry of members) {
    for (const capability of entry.capabilities) {
      const sources = byTag.get(capability) ?? []
      sources.push(entry.name)
      byTag.set(capability, sources)
    }
  }
  return [...byTag.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, sources]) => ({ tag, sources: [...new Set(sources)].sort() }))
}

const bundles = SUITES.map((suite) => {
  const members = suite.members.map(([npm, role]) => member(npm, role))

  // A duplicated key would make the host report two members as one slot, so
  // the install would look complete while a pane was missing.
  const keys = new Set()
  for (const entry of members) {
    if (keys.has(entry.key)) throw new Error(`duplicate member key "${entry.key}" in bundle ${suite.id}`)
    keys.add(entry.key)
  }
  return {
    id: suite.id,
    owner: 'dsh-suite-store',
    version: '0.1.0',
    title: suite.title,
    summary: suite.summary,
    category: { primary: suite.primary, secondary: suite.secondary },
    tags: suite.tags,
    cover: null,
    publishedAt: '2026-11-11',
    updatedAt: snapshot.updated ?? '2026-11-11',
    memberCount: members.length,
    capabilitySummary: capabilitySummary(members),
    needsBuildApproval: false,
    members: members.map((entry) => ({
      key: entry.key,
      name: entry.name,
      id: entry.id,
      version: entry.version,
      pinned: entry.pinned,
      spec: entry.spec,
    })),
    detail: `bundles/${suite.id}.json`,
    health: { status: 'ok', checkedAt: '2026-11-11', missing: [], deprecated: [] },
    score: { hotness: null, freshnessDays: 0, coverage: 1 },
  }
})

/**
 * The catalog's category tree, as the client wants it: primary id → secondary
 * ids (§5.2 `categories: Record<string, string[]>`).
 *
 * The upstream directory carries bilingual display names for every category
 * (`{ "agi": { "en": "AGI Architecture Exploration", "zh": "AGI 架构探索" } }`).
 * Those names are product copy, not data: they change on the site's schedule,
 * they would have to be shipped on every catalog refresh, and the plugin
 * already owns a bilingual table of its own. So the catalog keeps the ids and
 * the client supplies the words — one source of truth per string.
 *
 * A primary with no secondaries is dropped rather than emitted as `[]`: an
 * empty chip row is not a filter, and `selectBundles` treats an unknown
 * primary as "no filter", so a present-but-empty entry would only add noise.
 */
function categoryTree(upstream) {
  const tree = {}
  for (const primary of Object.keys(upstream ?? {})) {
    const used = new Set(
      SUITES.filter((suite) => suite.primary === primary && suite.secondary !== undefined)
        .map((suite) => suite.secondary),
    )
    if (used.size > 0) tree[primary] = [...used].sort()
  }
  return tree
}

const index = {
  format: 1,
  generatedAt: new Date().toISOString(),
  catalogRef: { updated: snapshot.updated ?? '2026-11-11', count: bundles.length },
  categories: categoryTree(snapshot.categories),
  bundles,
}

await writeFile(resolve(outPath), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`build-fixture-catalog: wrote ${bundles.length} bundles (${bundles.reduce((n, b) => n + b.memberCount, 0)} members) to ${outPath}`)

/**
 * The detail documents, one per card, next to the index (§5.3).
 *
 * Written here rather than by hand for the same reason as the index: the two
 * must agree, and they are generated from one snapshot. A card whose `detail`
 * path has no document behind it opens a sheet that silently falls back to the
 * card's own member list — which is the degraded path, not the product.
 */
const detailDir = resolve(dirname(resolve(outPath)), 'bundles')
await mkdir(detailDir, { recursive: true })
for (const suite of SUITES) {
  const card = bundles.find((entry) => entry.id === suite.id)
  const document = {
    format: 1,
    id: card.id,
    owner: card.owner,
    version: card.version,
    readme: suite.readme,
    // `{ tag, sources }` and not a bare word list: §5.5 argues that a warning
    // a user cannot trace to a plugin is a warning they learn to ignore, so
    // every capability names the members that declare it. `card.members` has
    // already been reduced to the wire shape, so read the words off the
    // directory entries instead.
    capabilities: capabilityList(
      card.members.map((member) => ({
        name: member.name,
        // Keyed by the npm package from the STABLE id: `byNpm` is keyed by
        // `plugin.npm`, while `member.name` is the directory's display name
        // (`dsh-web#packages/dsh-git-graph`). Looking the display name up
        // silently returned `[]` for every such package, so the detail sheet
        // disagreed with the card's own capability summary.
        capabilities: byNpm.get(member.id.slice('npm:'.length))?.capabilities ?? [],
      })),
    ),
    ...(suite.postInstall === undefined ? {} : { postInstall: suite.postInstall }),
    members: card.members.map((member) => ({
      ...member,
      reason: suite.roles[member.key],
    })),
  }
  await writeFile(resolve(detailDir, `${card.id}.json`), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}
console.log(`build-fixture-catalog: wrote ${SUITES.length} detail documents to ${detailDir}`)
