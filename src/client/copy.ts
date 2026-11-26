/**
 * Every sentence the store shows, in both languages.
 *
 * A literal table rather than the host's translated dictionaries, but the
 * LANGUAGE now comes from the host: `localeOfSnapshot` reads the host's own
 * `{ active }` snapshot and `LocaleGate` subscribes to it, so switching the
 * host language switches this page. Keeping the table local means the 100+
 * call sites stay `copy(key, locale)` instead of every one of them becoming a
 * bound `t(key)`; the table is what makes both columns provably the same size
 * (`tests/client-copy.spec.ts`).
 *
 * The rule that keeps it honest: **no Chinese or English string literal
 * appears in a component.** Anything a user can read is here, which is what
 * lets `tests/client-copy.spec.ts` prove both columns are the same size.
 */

/** The two languages the store is written in. */
import { createContext } from 'react'

export type Locale = 'zh' | 'en'

/** One key's two sentences. */
export interface Copy {
  zh: string
  en: string
}

/**
 * The page's copy.
 *
 * Placeholders are `{name}` and are filled by {@link fill}; a sentence with a
 * placeholder and a call site that forgets it is the one bug this shape
 * cannot catch, so the fill function is the only formatter in the page.
 */
export const COPY = {
  // ── page chrome ──────────────────────────────────────────────────────
  subtitle: { zh: '把常用插件一次装好，插件可单独开关', en: 'Install a curated set of plugins in one go' },
  retry: { zh: '重试', en: 'Retry' },

  searchPlaceholder: { zh: '搜索整合包、插件或标签', en: 'Search suites, members or tags' },
  searchLabel: { zh: '搜索', en: 'Search' },

  viewDiscover: { zh: '发现', en: 'Discover' },
  viewInstalled: { zh: '已安装', en: 'Installed' },
  viewEnhance: { zh: '可增强', en: 'Can add' },
  allCategories: { zh: '全部', en: 'All' },
  sortLabel: { zh: '排序', en: 'Sort' },
  hideBroken: { zh: '隐藏不可用的整合包', en: 'Hide unavailable suites' },

  // ── banners ──────────────────────────────────────────────────────────
  errorLoad: { zh: '目录加载失败：{reason}', en: 'Could not load the catalog: {reason}' },
  errorDetail: { zh: '详情加载失败：{reason}', en: 'Could not load the details: {reason}' },
  errorInstall: { zh: '无法开始安装：{reason}', en: 'Could not start the install: {reason}' },
  errorCancel: { zh: '无法停止：{reason}', en: 'Could not stop: {reason}' },
  errorUninstall: { zh: '卸载没有完成：{reason}', en: 'Uninstall did not finish: {reason}' },
  memberStars: { zh: 'GitHub 星数', en: 'GitHub stars' },
  memberWhy: { zh: '推荐理由', en: 'why it is here' },
  errorBoundaryTitle: { zh: '商店页面出错了', en: 'The store page hit an error' },
  errorBoundaryText: {
    zh: '页面渲染失败，但商店的数据没有受影响。可以重试，或重新打开这个页面。',
    en: 'Rendering failed; your store data is unaffected. Retry, or reopen this page.',
  },
  errorBoundaryRetry: { zh: '重试', en: 'Retry' },
  /** The export control, shared by the page header and the crash panel. */
  exportLog: { zh: '导出日志', en: 'Export log' },
  exportingLog: { zh: '正在导出…', en: 'Exporting…' },
  exportLogDone: { zh: '日志已下载', en: 'Log downloaded' },
  exportLogFailed: { zh: '导出失败：{reason}', en: 'Export failed: {reason}' },
  errorBoundaryExportLog: { zh: '导出日志', en: 'Export log' },
  errorSwitch: { zh: '切换未生效：{reason}', en: 'The switch did not apply: {reason}' },
  errorOffline: { zh: '无法连接宿主，请确认 dsh 正在运行', en: 'Cannot reach the host — is dsh running?' },
  empty: { zh: '没有符合条件的整合包', en: 'No suites match this filter' },
  emptyHint: { zh: '清空搜索，或选择其他分类', en: 'Clear the search, or pick another category' },
  loadMore: { zh: '加载更多', en: 'Load more' },
  sources: { zh: '{count} 个整合包 · 来自 {source}', en: '{count} suites · from {source}' },

  // ── card ────────────────────────────────────────────────────────────
  cardMembers: { zh: '{count} 个插件', en: '{count} members' },
  cardUpdated: { zh: '更新于 {date}', en: 'Updated {date}' },
  cardOwner: { zh: '{owner}', en: '{owner}' },
  cardMembersToggle: { zh: '插件 {count}', en: 'Members {count}' },
  memberPagePrev: { zh: '上一页', en: 'Previous page' },
  memberPageNext: { zh: '下一页', en: 'Next page' },
  memberPageOf: { zh: '{page}/{pages}', en: '{page}/{pages}' },
  cardBy: { zh: '作者 {owner}', en: 'by {owner}' },
  moreTags: { zh: '+{count}', en: '+{count}' },
  badgeBroken: { zh: '插件不可用', en: 'Unavailable members' },
  badgeDegraded: { zh: '插件版本过时', en: 'Stale members' },
  badgeBuild: { zh: '构建脚本待批准', en: 'Build scripts need approval' },
  badgeWarnPerm: { zh: '高权限', en: 'Wide permissions' },

  // ── the card's action button ────────────────────────────────────────
  actionInstall: { zh: '安装', en: 'Install' },
  /**
   * The dialog's own install button, which is the one place the action is the
   * whole suite in one press. The card's button stays 「安装」: on a card the
   * reader is still deciding, while the sheet's is the commit.
   */
  actionInstallAll: { zh: '一键安装', en: 'Install all' },
  actionInstalled: { zh: '已装 {have}/{of}', en: 'Installed {have}/{of}' },
  actionInstalling: { zh: '安装中 {done}/{total}', en: 'Installing {done}/{total}' },
  actionRemoving: { zh: '卸载中 {done}/{total}', en: 'Removing {done}/{total}' },
  actionBlocked: { zh: '此宿主不支持安装', en: 'Install not supported on this host' },
  /** The host is fine; it is finishing another bundle's run (§7.1). */
  actionBusy: { zh: '等待当前安装完成', en: 'Waiting for the current install' },
  actionDetails: { zh: '详情', en: 'Details' },

  // ── capability copy (§8.6: 权限要说人话) ────────────────────────────
  //
  // One sentence per tag the catalog can emit, because §8.3 asks for a
  // sentence rather than a tag ("不列 fs-write，而写「会读写你的文件」").
  // The list is not decorative: `tests/client-data.spec.ts` walks it against
  // `capabilitySentence` so a new tag in the catalog cannot reach a card as a
  // bare identifier.
  //
  // Register: a capability is a fact about scope, so each one is written as a
  // verb phrase with no subject and no second person — "读取本地文件", not
  // "可以读取你这台电脑上的文件".
  capsLabel: { zh: '权限范围', en: 'Permissions' },
  capsNone: { zh: '未声明额外权限', en: 'No additional permissions declared' },
  /** The tooltip header over the plugins that declare one permission. */
  capSourcesTitle: { zh: '{count} 个插件声明了此权限', en: 'Declared by {count} member(s)' },
  capsCaveat: {
    zh: '扫描结果仅反映已声明的能力，不作为安全评估结论。',
    en: 'Reflects declared capabilities only; not a security assessment.',
  },
  capGroupFileEnv: { zh: '文件与环境', en: 'Files & environment' },
  capGroupNetwork: { zh: '网络', en: 'Network' },
  capGroupExec: { zh: '命令与代码', en: 'Commands & code' },
  capGroupCredentials: { zh: '凭据', en: 'Credentials' },
  capGroupModel: { zh: '模型', en: 'Model' },
  capGroupHost: { zh: '宿主', en: 'Host' },
  capGroupOther: { zh: '其他', en: 'Other' },
  capsShell: { zh: '执行本机命令', en: 'Execute local commands' },
  capsFsWrite: { zh: '写入本地文件', en: 'Write local files' },
  capsNetwork: { zh: '访问互联网', en: 'Access the internet' },
  capsFsRead: { zh: '读取本地文件', en: 'Read local files' },
  capsEnv: { zh: '读取环境变量', en: 'Read environment variables' },
  capsCredentials: { zh: '访问凭据与密钥', en: 'Access credentials and keys' },
  capsLlm: { zh: '调用模型服务并使用额度', en: 'Call model services, consuming quota' },
  capsSubagent: { zh: '创建子任务', en: 'Create sub-tasks' },
  capsDynamicCode: { zh: '执行运行时生成的代码', en: 'Execute code generated at runtime' },
  capsHost: { zh: '注册到宿主进程', en: 'Registers with the host process' },

  // ── details dialog ─────────────────────────────────────────────────
  dialogTitle: { zh: '整合包详情', en: 'Suite details' },
  close: { zh: '关闭', en: 'Close' },
  cancel: { zh: '取消', en: 'Cancel' },
  /** The count on a folded section's header row ("4 项"). */
  foldItems: { zh: '{count} 项', en: '{count} items' },
  membersLabel: { zh: '插件', en: 'Member plugins' },
  memberName: { zh: '插件', en: 'Member' },
  memberVersion: { zh: '版本', en: 'Version' },
  memberState: { zh: '状态', en: 'Status' },
  memberPinned: { zh: '版本锁定', en: 'Pinned' },
  memberNeedsDsh: { zh: '需 dsh {range}', en: 'needs dsh {range}' },
  memberFloating: { zh: '跟随最新', en: 'Follows latest' },
  memberStateLoading: { zh: '读取状态…', en: 'Reading…' },
  memberPresentDisabled: { zh: '已停用，重启后移除', en: 'Disabled — removed on restart' },
  memberHere: { zh: '已安装', en: 'Installed' },
  memberHereShort: { zh: '已装', en: 'Installed' },
  memberEnabledLabel: { zh: '启用', en: 'Enabled' },
  memberSwitchOn: { zh: '已启用', en: 'Enabled' },
  memberSwitchOff: { zh: '已停用', en: 'Disabled' },
  memberInstallOne: { zh: '安装', en: 'Install' },
  memberInstallOneTitle: { zh: '仅安装此插件，其余插件保持不变', en: 'Install this member only; the rest are left unchanged' },
  memberAbsent: { zh: '未安装', en: 'Not installed' },
  memberUnknownState: { zh: '宿主未报告状态', en: 'No state reported by the host' },
  postInstall: { zh: '安装后', en: 'After install' },
  bundleInfoLabel: { zh: '整合包信息', en: 'Suite information' },
  infoCategory: { zh: '分类', en: 'Category' },
  infoOwner: { zh: '作者', en: 'Author' },
  infoVersion: { zh: '版本', en: 'Version' },
  infoUpdated: { zh: '更新时间', en: 'Updated' },
  infoTestedWith: { zh: '验证于', en: 'Tested with' },
  redLinesLabel: { zh: '风险组合提示', en: 'Risk combinations' },
  infoDesktopHost: {
    zh: '安装与卸载由宿主的插件管理器执行',
    en: 'Installs and removals are performed by the host plugin manager',
  },
  readmeEmpty: { zh: '该整合包未提供说明', en: 'No description provided' },
  loadingDetail: { zh: '正在加载详情…', en: 'Loading details…' },

  // ── install progress ───────────────────────────────────────────────
  progressTitle: { zh: '正在安装 {id}', en: 'Installing {id}' },
  /**
   * The removal's half of the same panel.
   *
   * A removal shares the record, the counters and the member list with an
   * install, so only the verbs differ. Reusing `progressTitle` here made the
   * sheet say 「正在安装」 while it was deleting — the one sentence a user must
   * be able to trust in a destructive flow.
   */
  progressRemoveTitle: { zh: '正在卸载 {id}', en: 'Removing {id}' },
  progressRemoveDone: { zh: '卸载完成', en: 'Removal complete' },
  progressRemovePartial: {
    zh: '{failed} 个插件未移除，其余已完成',
    en: '{failed} members were not removed; the rest completed',
  },
  progressCount: { zh: '{done}/{total}', en: '{done}/{total}' },
  progressCancel: { zh: '停止', en: 'Stop' },
  progressCancelHint: {
    zh: '在当前插件完成后停止',
    en: 'Stops once the current member finishes',
  },
  progressCancelled: { zh: '已停止', en: 'Stopped' },
  progressRestarting: { zh: '正在重启宿主…', en: 'Restarting the host…' },
  progressVerifying: { zh: '正在校验插件状态…', en: 'Verifying member state…' },
  progressDone: { zh: '安装完成', en: 'Install complete' },
  progressPartial: {
    zh: '{failed} 个插件未安装，其余已完成',
    en: '{failed} members were not installed; the rest completed',
  },
  progressBlocked: { zh: '未执行：{reason}', en: 'Not started: {reason}' },
  /** The same state with no reason recorded — a separate sentence so the
   *  colon is not left dangling after the placeholder is removed. */
  progressBlockedNoReason: { zh: '未执行', en: 'Not started' },
  /** The progress bar's accessible name; the visible title says the state. */
  progressBarLabel: { zh: '安装进度', en: 'Install progress' },
  progressDismiss: { zh: '关闭', en: 'Dismiss' },
  /** What the run is doing right now, named per member. */
  progressWorkingOn: { zh: '正在安装 {name}', en: 'Installing {name}' },
  progressWorkingOff: { zh: '正在卸载 {name}', en: 'Removing {name}' },
  progressResume: { zh: '继续未完成的插件', en: 'Continue remaining members' },
  statePending: { zh: '等待中', en: 'waiting' },
  stateRunning: { zh: '进行中', en: 'running' },
  stateOk: { zh: '已完成', en: 'done' },
  failRemoveNeedsRestart: {
    zh: '已停用，重启 DSH 后彻底移除（完全退出程序，不是刷新页面）',
    en: 'Disabled — it is gone once DSH restarts (quit the app fully, a page refresh is not enough)',
  },
  stateNeedsRestart: { zh: '已停用，重启后移除', en: 'Disabled — removed on restart' },
  stateFailed: { zh: '失败', en: 'failed' },
  stateSkipped: { zh: '已跳过', en: 'skipped' },
  stateBuildDenied: { zh: '构建未批准', en: 'build not approved' },

  // ── failure copy (§7.4) ────────────────────────────────────────────
  failInstall: { zh: '安装失败：{reason}', en: 'Install failed: {reason}' },
  /**
   * Why an install failed, per machine-readable cause.
   *
   * The reason the panel used to print was an English sentence built on the
   * server, where the reader's language is not known — so a Chinese reader got
   * "needs @deepseek-ai/dsh-x 0.2.1-rc.3, which dsh 0.2.2-rc.5 does not
   * provide" in the middle of a Chinese page. The sentence is still the fallback
   * (it carries the package names and ranges), but the part that explains the
   * SITUATION is now translated here.
   */
  causeIncompatibleVersion: {
    zh: '此插件要求的 dsh 版本与当前运行时不一致。',
    en: 'This plugin requires a dsh version this runtime does not provide.',
  },
  causeIncompatibleApi: {
    zh: '插件装上了，但它需要的 dsh 接口在当前版本里不存在（通常因为插件实际要求的 dsh 版本比它声明的更高）。',
    en: 'The plugin installed, but it imports a dsh interface this version does not have — usually because it actually needs a newer dsh than its engines field declares.',
  },
  causeGitPrepareRefused: {
    zh: '这个插件要从 GitHub 构建，pnpm 默认不执行 git 依赖的构建脚本。批准它的构建即可安装。',
    en: 'This plugin builds from GitHub, and pnpm does not run a git dependency’s build scripts by default. Approving its build allows the install.',
  },
  causePackageManager: {
    zh: '包管理器拒绝了这次安装。',
    en: 'The package manager refused this install.',
  },
  causeBundleInUse: {
    zh: '另一个插件仍在使用它，暂时不能更改。',
    en: 'Another plugin is still using this one, so it cannot be changed right now.',
  },
  causeNotRemovable: {
    zh: '宿主不允许移除这个插件。',
    en: 'The host does not allow removing this plugin.',
  },
  causeStaleApproval: {
    zh: '构建脚本的授权已过期，请重新确认。',
    en: 'The build-script approval expired; approve it again.',
  },
  causeStopProfile: {
    zh: '宿主正在停止，拒绝修改配置。',
    en: 'The host refused to change the profile while it is stopping.',
  },
  causeManagementRequired: {
    zh: '这个插件由宿主的必需层管理，不能在此处修改。',
    en: 'The host manages this plugin as a required layer, so it cannot be changed here.',
  },
  causeAmbiguousInstall: {
    zh: '宿主无法确认这次安装是否成功，请先检查插件列表。',
    en: 'The host could not tell whether the install landed; check the plugin list before retrying.',
  },
  failLoad: { zh: '安装完成，但宿主加载失败：{reason}', en: 'Installed, but the host failed to load it: {reason}' },
  failVerify: { zh: '宿主未确认安装结果：{reason}', en: 'The host did not confirm the install: {reason}' },
  failBuild: { zh: '构建脚本未获批准，已取消安装', en: 'Build scripts were not approved; install cancelled' },
  failTooLate: {
    zh: '安装已超过 5 分钟，停止请求未及时生效。它可能已经安装成功，请先确认再重试',
    en: 'The install has run past five minutes and the stop arrived too late. It may have succeeded — verify before retrying',
  },
  failDrift: {
    zh: '声明版本 {requested}，实际安装 {resolved}',
    en: 'Declared {requested} but {resolved} was installed',
  },
  failRemove: { zh: '未能移除：{reason}', en: 'Not removed: {reason}' },

  /**
   * §7.2: the build-script question, asked once before the run.
   *
   * The member names are in the sentence because a permission the user cannot
   * trace to a plugin is one they learn to accept blindly.
   */
  approveBuilds: {
    zh: '批准以下插件的构建脚本：{names}',
    en: 'Approve build scripts for: {names}',
  },
  approveBuildsNote: {
    zh: '构建脚本用于打包或编译，安装时执行。pnpm 默认不执行依赖的构建脚本，需显式批准。未批准时该插件跳过，其余插件正常安装。',
    en: 'Build scripts bundle or compile a package at install time. pnpm does not run a dependency’s build scripts unless explicitly approved. Unapproved members are skipped; the rest install normally.',
  },

  // ── uninstall ──────────────────────────────────────────────────────
  uninstall: { zh: '卸载', en: 'Uninstall' },
  /**
   * The dialog's own removal button, the mirror of 一键安装.
   *
   * It is shown only when at least one of the bundle's members is on disk,
   * which is exactly what the removal preview answers: a dialog opened on a
   * suite that is not installed has nothing to remove, and offering the button
   * anyway would promise an action with an empty checklist behind it.
   */
  actionStop: { zh: '停止安装', en: 'Stop install' },
  selectAll: { zh: '全选', en: 'Select all' },
  selectNone: { zh: '全不选', en: 'Clear all' },
  uninstallAll: { zh: '一键卸载', en: 'Uninstall all' },
  uninstallTitle: { zh: '卸载 {id}', en: 'Uninstall {id}' },
  uninstallPreview: { zh: '正在计算卸载范围…', en: 'Calculating removal scope…' },
  uninstallOnlySource: {
    zh: '仅由本整合包引入',
    en: 'Introduced only by this suite',
  },
  uninstallManual: {
    zh: '手动安装',
    en: 'Installed manually',
  },
  uninstallShared: {
    zh: '同时被其他整合包使用',
    en: 'Also used by other suites',
  },
  uninstallUnknown: {
    zh: '来源未知',
    en: 'Origin unknown',
  },
  uninstallSharedWarn: { zh: '仍被 {others} 使用', en: 'Also used by {others}' },
  uninstallConfirm: { zh: '卸载所选 {count} 项', en: 'Uninstall {count} selected' },
  uninstallPicked: { zh: '已选 {count}/{total}', en: '{count} of {total} selected' },
  uninstallNonePicked: {
    zh: '移除本整合包的全部插件；来源标签仅供参考，可取消勾选。',
    en: 'Remove every member of this suite; provenance labels are informational — untick any row to keep it.',
  },
  uninstallWillRemove: {
    zh: '将移除 {count} 个插件，并清理其来源记录。',
    en: '{count} member(s) will be removed and their provenance cleared.',
  },
  uninstallNothing: { zh: '没有可移除的插件', en: 'No removable members' },

  // ── host refusals (§7.2) ───────────────────────────────────────────
  blockedBusy: { zh: '宿主正忙，请稍后重试', en: 'The host is busy; retry shortly' },
  blockedUnavailable: { zh: '该宿主未提供插件管理器', en: 'This host provides no plugin manager' },


  sortRecommended: { zh: '推荐', en: 'Recommended' },
  sortUpdated: { zh: '最近更新', en: 'Recently updated' },
  sortMembers: { zh: '插件最多', en: 'Most members' },
  sortHottest: { zh: '最热', en: 'Hottest' },
  updatedWithinLabel: { zh: '更新时间', en: 'Updated' },
  updatedAny: { zh: '任意时间', en: 'Any time' },
  updated7: { zh: '7 天内', en: 'Last 7 days' },
  updated30: { zh: '30 天内', en: 'Last 30 days' },
  updated90: { zh: '90 天内', en: 'Last 90 days' },
  /**
   * §5.6 requires this sentence wherever the list is ordered by hotness.
   *
   * `hotness` is the mean of the members' own popularity (D25/D26); this store
   * tracks no install counts, so without the note "hottest" reads as "most
   * installed", which is a claim the catalog cannot make.
   */
  hotnessNote: {
    zh: '按插件热度聚合，非本包安装量',
    en: 'Aggregated from member plugin popularity, not this bundle’s install count',
  },
  // ── suite submission ───────────────────────────────────────────────
  submitSuite: { zh: '申请收录整合包', en: 'Submit a suite' },
  submitTitle: { zh: '申请收录整合包', en: 'Submit a suite' },
  submitIntro: {
    zh: '填写最小投稿信息，生成可直接提交到 catalog 仓库的 YAML 文件。',
    en: 'Fill in the minimum submission fields and generate a YAML file for the catalog repository.',
  },
  submitBasics: { zh: '基础信息', en: 'Basics' },
  submitOwner: { zh: 'GitHub 登录名', en: 'GitHub login' },
  submitOwnerHint: { zh: '作为整合包目录的 owner', en: 'Used as the suite directory owner' },
  submitId: { zh: '整合包 ID', en: 'Suite ID' },
  submitIdHint: { zh: '小写字母、数字和连字符，2–39 位', en: 'Lowercase letters, digits and hyphens, 2–39 characters' },
  submitVersion: { zh: '版本号', en: 'Version' },
  submitVersionHint: { zh: '使用 MAJOR.MINOR.PATCH', en: 'Use MAJOR.MINOR.PATCH' },
  submitTitleField: { zh: '标题', en: 'Title' },
  submitTitleEn: { zh: '英文标题', en: 'English title' },
  submitTitleZh: { zh: '中文标题（选填）', en: 'Chinese title (optional)' },
  submitSummaryField: { zh: '摘要', en: 'Summary' },
  submitSummaryEn: { zh: '英文摘要', en: 'English summary' },
  submitSummaryZh: { zh: '中文摘要（选填）', en: 'Chinese summary (optional)' },
  submitSummaryCount: { zh: '{count}/40', en: '{count}/40' },
  submitCategory: { zh: '一级分类', en: 'Primary category' },
  submitCategoryPlaceholder: { zh: '选择分类', en: 'Choose a category' },
  submitMembers: { zh: '成员插件', en: 'Member plugins' },
  submitMembersHint: { zh: '点击整行选择插件，2–10 个', en: 'Click a row to select 2–10 plugins' },
  submitMembersCount: { zh: '已选 {count}/{max}', en: 'Selected {count}/{max}' },
  submitInstalledTab: { zh: '已安装插件', en: 'Installed plugins' },
  submitSearchTab: { zh: '精选索引', en: 'Curated index' },
  submitInstalledLoading: { zh: '正在匹配已安装插件…', en: 'Matching installed plugins…' },
  submitInstalledEmpty: { zh: '当前已安装插件中没有精选索引成员', en: 'No installed plugin matches the curated index' },
  submitInstalledError: { zh: '读取已安装插件失败：{reason}', en: 'Could not read installed plugins: {reason}' },
  submitSearchPlaceholder: { zh: '搜索插件名称、owner/name 或描述', en: 'Search plugin name, owner/name or description' },
  submitSearchHint: { zh: '输入关键词搜索全部精选插件；留空时显示已安装且已收录的插件', en: 'Search every curated plugin; leave blank to show installed curated plugins' },
  submitSearchEmpty: { zh: '没有匹配的精选插件', en: 'No curated plugin matches' },
  submitSearchLoading: { zh: '正在搜索…', en: 'Searching…' },
  submitSearchError: { zh: '搜索失败：{reason}', en: 'Search failed: {reason}' },
  submitInstalledBadge: { zh: '已安装', en: 'Installed' },
  submitCuratedBadge: { zh: '精选索引', en: 'Curated' },
  submitResultCount: { zh: '{count} 个匹配', en: '{count} matches' },
  submitNoDescription: { zh: '暂无简介', en: 'No description' },
  submitAdd: { zh: '添加', en: 'Add' },
  submitAdded: { zh: '已添加', en: 'Added' },
  submitRemove: { zh: '移除', en: 'Remove' },
  submitSelected: { zh: '已选成员', en: 'Selected members' },
  submitSelectedEmpty: { zh: '还没有选择成员', en: 'No members selected yet' },
  submitGuide: { zh: '投稿规范', en: 'Submission guide' },
  submitGuideHint: { zh: '提交前请阅读 catalog 仓库的 CONTRIBUTING.md', en: 'Read the catalog repository CONTRIBUTING.md before submitting' },
  submitPathHint: { zh: '保存为 suites/{owner}/{id}/{version}.yml', en: 'Save as suites/{owner}/{id}/{version}.yml' },
  submitDownload: { zh: '生成投稿文件', en: 'Generate submission file' },
  submitCatalogLoading: { zh: '分类仍在加载，请稍候', en: 'Categories are still loading' },
  submitErrorRequired: { zh: '必填', en: 'Required' },
  submitErrorOwner: { zh: 'GitHub 登录名格式不正确', en: 'Invalid GitHub login' },
  submitErrorId: { zh: '整合包 ID 格式不正确', en: 'Invalid suite ID' },
  submitErrorVersion: { zh: '版本号必须是 MAJOR.MINOR.PATCH', en: 'Version must be MAJOR.MINOR.PATCH' },
  submitErrorTitleLong: { zh: '标题超过 80 个字符', en: 'Title exceeds 80 characters' },
  submitErrorSummaryLong: { zh: '摘要超过 40 个字符', en: 'Summary exceeds 40 characters' },
  submitErrorCategory: { zh: '请选择有效分类', en: 'Choose a valid category' },
  submitErrorMemberCount: { zh: '成员数量必须为 2–10 个', en: 'Choose 2–10 members' },
  submitErrorInvalidMember: { zh: '存在格式不正确的成员', en: 'A member reference is malformed' },
  submitErrorDuplicateMember: { zh: '成员不能重复', en: 'Members must be unique' },
  allChips: { zh: '全部', en: 'All' },
  // English keeps the package name everywhere it appears: the sidebar row,
  // the plugin list and this page heading must be the same string, or the
  // store has three names.
  pageTitle: { zh: '插件整合包商店', en: 'Plugin Suite Store' },
  pageSubtitle: { zh: '{count} 个整合包 · 目录更新于 {date}', en: '{count} suites · catalog updated {date}' },
  pageSubtitleLoading: { zh: '正在读取目录…', en: 'Reading the catalog…' },
  loadingCatalog: { zh: '正在加载整合包…', en: 'Loading suites…' },
  emptyCatalog: { zh: '目录里还没有整合包', en: 'The catalog lists no suites yet' },
  noMatches: { zh: '当前筛选下没有匹配的整合包', en: 'No suite matches the current filters' },
  bannerNoInstall: { zh: '这个宿主没有可用的插件管理器，只能浏览', en: 'This host has no usable plugin manager — browsing only' },
} as const satisfies Record<string, Copy>

/** Every copy key this build ships. */
export type CopyKey = keyof typeof COPY

/**
 * Look one sentence up.
 *
 * @param key - the key; the type makes an unknown one a compile error.
 * @param locale - which language to answer in.
 * @returns the sentence, in that language.
 */
export function t(key: CopyKey, locale: Locale): string {
  return COPY[key][locale]
}

/**
 * Look a sentence up and fill its placeholders.
 *
 * A placeholder with no matching value is left as-is rather than blanked:
 * `{reason}` on screen is a bug report, while an empty gap reads as a broken
 * sentence and gets reported as one.
 *
 * @param key - the sentence.
 * @param locale - which language.
 * @param values - what to put in the `{name}` slots.
 * @returns the finished sentence.
 */
export function fill(
  key: CopyKey,
  locale: Locale,
  values: Record<string, string | number>,
): string {
  return t(key, locale).replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name]
    return value === undefined ? whole : String(value)
  })
}

/** A locale tag for `Date`/`Intl`, from the page's locale. */
export function localeTag(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US'
}

/**
 * Which language to draw in.
 *
 * The host's `<html lang>` is the one signal every shell sets and this plugin
 * may read; anything not starting with `zh` renders English, because the
 * English column is the one written first and the one every contributor can
 * read.
 *
 * @param languages - the browser's preference list, most preferred first.
 * @returns the locale.
 */
export function pickLocale(languages: readonly string[] = []): Locale {
  for (const language of languages) {
    if (typeof language !== 'string') continue
    return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }
  return 'en'
}

/**
 * Read a language out of whatever the host's locale service published.
 *
 * The shipped service answers `{ active, locales, revision }`. Two other
 * shapes have been seen from older or partial shims: a bare tag, and an
 * object with `locale` / `language`. All of them are read here because the
 * failure is silent — an unread snapshot falls back to the browser, and a
 * machine whose OS language is Chinese keeps the page in Chinese after the
 * user switches the host to English.
 *
 * @param snapshot - whatever `getSnapshot()` returned.
 * @returns the language, or undefined when the shape says nothing.
 */
export function localeOfSnapshot(snapshot: unknown): Locale | undefined {
  if (typeof snapshot === 'string') return snapshot === '' ? undefined : pickLocale([snapshot])
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const record = snapshot as { active?: unknown; locale?: unknown; language?: unknown }
  const value =
    typeof record.active === 'string'
      ? record.active
      : typeof record.locale === 'string'
        ? record.locale
        : record.language
  return typeof value === 'string' && value !== '' ? pickLocale([value]) : undefined
}

/**
 * The language every component draws in, provided once at the page's root.
 *
 * A context rather than a prop threaded through six components: the locale is
 * fixed for the life of a mount and every leaf needs it, which is exactly the
 * shape a context is for.
 */
export const LocaleContext = createContext<Locale>('en')
