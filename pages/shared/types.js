/**
 * The shapes the service returns, as the pages read them. They mirror the
 * typedefs in service/store.mjs.
 *
 * @typedef {'not-started' | 'active' | 'done' | 'closed'} StatusGroup
 * @typedef {{ uid: number, name: string, group: StatusGroup, colour: string, icon: string, isDefault: boolean }} Status
 * @typedef {{ uid: number, name: string, rank: number, isDefault: boolean }} Priority
 * @typedef {{ open: number, active: number, done: number, closed: number }} Counts
 * @typedef {{ uid: number, name: string, colour: string, folders: string[],
 *   portfolio: { uid: number, key: string, name: string }, counts: Counts }} Project
 * @typedef {{ uid: number, id: string, title: string, status: { name: string, group: StatusGroup, colour: string, icon: string } }} InitiativeLink
 * @typedef {{ uid: number, key: string, name: string, description: string, nextNumber: number, projects: Project[], initiatives: InitiativeLink[] }} PortfolioSummary
 * @typedef {PortfolioSummary & { statuses: Status[], priorities: Priority[] }} Portfolio
 * @typedef {{ id: string, name: string, activeAt: string | null }} SessionClaim
 * @typedef {'initiative' | 'epic' | 'task'} ItemKind
 * @typedef {{
 *   uid: number, id: string, kind: ItemKind, title: string,
 *   portfolio: { uid: number, key: string },
 *   project: { uid: number, name: string, colour: string },
 *   epic: { id: string, title: string } | null,
 *   initiative: { id: string, title: string } | null,
 *   stage: { uid: number, n: number, title: string } | null,
 *   status: { uid: number, name: string, group: StatusGroup, colour: string, icon: string },
 *   priority: { uid: number, name: string },
 *   criteria: { done: number, total: number },
 *   waitingOn: string[],
 *   session: SessionClaim | null,
 *   updatedAt: string
 * }} ItemSummary
 * @typedef {{ n: number, text: string, done: boolean }} Criterion
 * @typedef {{ uid: number, kind: string, value: string, label: string }} Link
 * @typedef {'artifact' | 'doc' | 'file' | 'url'} RefKind
 * @typedef {{ uid: number, kind: RefKind, target: string, title: string, use: string, key: boolean }} Reference
 * @typedef {'epic' | 'initiative' | 'project' | 'portfolio'} RefLevel
 * @typedef {Reference & { from: { level: RefLevel, uid: number, name: string } }} InheritedReference
 * @typedef {{ at: string, by: string, text: string, ref: string | null }} LogEntry
 * @typedef {{ done: string, left: string, next: string, by: string, at: string }} Handoff
 * @typedef {ItemSummary & {
 *   description: string, createdAt: string, createdBy: string | null,
 *   criteriaList: Criterion[], links: Link[], refs: Reference[],
 *   waitsOn: ItemSummary[], blocks: ItemSummary[],
 *   handoff: Handoff | null, log: { entries: LogEntry[], total: number },
 *   epics: ItemSummary[] | null, tasks: ItemSummary[] | null, spans: string[] | null
 * }} Item
 * @typedef {'empty' | 'not-started' | 'active' | 'done'} StageState
 * @typedef {{ done: number, active: number, total: number }} Tally
 * @typedef {ItemSummary & { rest: (Tally & { tasks: string[] }) | null }} PlanEntry an epic's `rest` is its tasks not in a stage of their own
 * @typedef {{ uid: number, n: number, title: string, goal: string, state: StageState, items: PlanEntry[] } & Tally} Stage
 * @typedef {{ item: string, stage: number, waitsOn: string, waitsOnStage: number }} Conflict
 * @typedef {{ uid: number, id: string, kind: 'initiative' | 'epic', title: string }} PlanOwner
 * @typedef {{ owner: PlanOwner, stages: Stage[], current: number | null, progress: Tally, epics: (ItemSummary & { progress: Tally })[], unplaced: ItemSummary[], conflicts: Conflict[] }} Plan
 * @typedef {{ uid: number, n: number, title: string }} StageChoice
 * @typedef {{ owner: PlanOwner, stages: StageChoice[], stage: (StageChoice & { viaEpic: boolean }) | null }} Placement
 * @typedef {Omit<Stage, 'items' | 'goal'>} StageSummary
 * @typedef {ItemSummary & { epics: number, progress: Tally, stages: StageSummary[], current: number | null, unplaced: number, conflicts: number }} InitiativeOverview
 * @typedef {{ items: ItemSummary[], total: number }} FindResult
 * @typedef {Project & { place: string | null }} PlacedProject
 * @typedef {{ project: number, done: number, active: number, open: number }} EpicCell
 * @typedef {ItemSummary & { done: number, total: number, cells: EpicCell[] }} EpicOverview
 * @typedef {{ id: string, uid: number, title: string, project: { uid: number, name: string, colour: string } }} Blocker
 * @typedef {{
 *   portfolio: Portfolio & { projects: PlacedProject[] },
 *   stats: {
 *     open: { count: number, series: number[], days: number },
 *     active: { count: number, sessions: string[], withSession: number },
 *     waiting: { count: number, crossProject: number },
 *     done: { count: number, days: number[] }
 *   },
 *   initiatives: InitiativeOverview[],
 *   epics: EpicOverview[],
 *   active: ItemSummary[],
 *   waiting: { item: ItemSummary, waitsOn: Blocker[] }[],
 *   refs: Reference[],
 *   missing: number[]
 * }} PortfolioOverview
 * @typedef {{
 *   project: PlacedProject,
 *   portfolio: { uid: number, key: string, name: string, nextNumber: number, statuses: Status[], priorities: Priority[] },
 *   items: ItemSummary[],
 *   refs: Reference[],
 *   missing: number[]
 * }} ProjectOverview
 * @typedef {{
 *   item: Item,
 *   portfolio: { uid: number, key: string, name: string, statuses: Status[], priorities: Priority[] },
 *   projects: PlacedProject[],
 *   epics: ItemSummary[],
 *   initiatives: ItemSummary[],
 *   order: { uid: number, depth: number }[] | null,
 *   plan: Plan | null,
 *   placement: Placement | null,
 *   inherited: InheritedReference[],
 *   missing: number[]
 * }} ItemOverview
 * @typedef {{
 *   portfolio: Omit<Portfolio, 'projects'> & { projects: PlacedProject[] },
 *   items: number,
 *   uses: { statuses: Record<number, number>, priorities: Record<number, number>, projects: Record<number, number> }
 * }} PortfolioSettings
 */

export {}
