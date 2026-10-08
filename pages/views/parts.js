/**
 * What every view module is, to the view page that loads it.
 *
 * @typedef {{ setPlace(place: { portfolio?: number, project?: number }): void, reload(): void }} Host
 * @typedef {{ load(isCurrent: () => boolean): Promise<void>, focus?(): void }} View
 */

export {}
