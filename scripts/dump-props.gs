// scripts/dump-props.gs
// Paste into the Apps Script editor, run once, copy the log output into
// scripts/data/props.json.
function dumpProps() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var out = {
    states: JSON.parse(all.states || '{}'),
    choreStates: JSON.parse(all.choreStates || '{}'),
    categories: JSON.parse(all.categories || '[]'),
    chorePauseUntil: all.chorePauseUntil || '',
  };
  Logger.log(JSON.stringify(out));
}
