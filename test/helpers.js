export function windowOf(db) {
  const maxDay = db.prepare('SELECT MAX(day) AS d FROM graph_edges').get().d;
  const anchor = new Date(`${maxDay}T00:00:00.000Z`);
  return {
    from: new Date(anchor.getTime() - 6 * 86400e3).toISOString(),
    to: new Date(anchor.getTime() + 86400e3).toISOString(),
  };
}
