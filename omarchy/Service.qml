import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "Runtime.js" as Runtime

Item {
  id: root
  property var settings: ({})
  property var summary: null
  property string error: ""
  property double nowMs: Date.now()
  property string _output: ""
  property string _diagnostics: ""
  readonly property var group: Model.activeGroup(summary)
  readonly property var observation: summary ? summary.observation : null
  readonly property bool busy: query.running
  readonly property bool stale: Model.stale(summary, nowMs)
  readonly property string label: Model.barLabel(summary, error)
  readonly property int refreshIntervalSec: {
    var n = Number(settings.refreshIntervalSec)
    return isFinite(n) && n >= 10 ? Math.min(300, Math.floor(n)) : 60
  }

  function refresh() {
    if (query.running) return
    _output = ""
    _diagnostics = ""
    query.running = true
  }

  Component.onCompleted: refresh()
  Timer { interval: 1000; running: true; repeat: true; onTriggered: root.nowMs = Date.now() }
  Timer { interval: root.refreshIntervalSec * 1000; running: true; repeat: true; onTriggered: root.refresh() }

  Process {
    id: query
    command: ["timeout", "10s"].concat(Runtime.command.length ? Runtime.command :
      ["bun", Quickshell.env("HOME") + "/projects/codex-usage/index.ts", "summary", "--json"])
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root._output = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root._diagnostics = text }
    onExited: function(code) {
      try {
        if (code === 124) throw new Error("Reading the local usage summary timed out.")
        if (!root._output.trim()) throw new Error(root._diagnostics.trim() || "The usage collector could not be started.")
        var data = Model.parseSummary(root._output)
        if (code !== 0) throw new Error("The usage collector exited with code " + code + ".")
        root.summary = data
        root.error = ""
      } catch (e) {
        root.error = String(e.message || e)
      }
    }
  }
}
