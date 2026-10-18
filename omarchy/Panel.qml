import QtQuick
import QtQuick.Controls as QQC
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "egge.codex-usage"
  ipcTarget: "egge.codex-usage"
  manageIpc: false
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property var group: usage.group
  readonly property var observation: usage.observation
  readonly property var value: group && group.value ? group.value : null
  readonly property var calibration: value ? value.currentCalibration : null
  readonly property string sourceProblem: Model.sourceProblem(calibration)
  readonly property string nextReset: !observation ? "—" :
    Date.parse(observation.resetsAt) <= usage.nowMs ? "Awaiting updated reset time" :
    "In " + Model.duration((Date.parse(observation.resetsAt) - usage.nowMs) / 1000)
  property bool details: false
  property int actionIndex: 0

  function showPage(showDetails) {
    details = showDetails
    actionIndex = 0
    scroll.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function refresh() { usage.refresh() }
  function statusJson() { return JSON.stringify({ label: usage.label, error: usage.error, stale: usage.stale, page: details ? "details" : "report", summary: usage.summary }) }
  function localDate(iso) { return iso ? Qt.formatDateTime(new Date(iso), "d MMM yyyy, HH:mm") : "—" }
  onOpenedChanged: if (opened) {
    usage.refresh()
    showPage(false)
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Service { id: usage; settings: root.settings }
  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string { return root.statusJson() }
  }

  WidgetButton {
    id: button
    bar: root.bar
    text: usage.label
    foreground: usage.error || usage.stale || root.sourceProblem ? root.urgent : root.barForeground
    tooltipText: "Codex FOMO · " + Model.reportCaption(usage.summary, usage.error)
      + (usage.error ? "\n" + usage.error : "")
      + (root.value && root.value.unvaluedResetCount > 0 ? "\n* Some resets have no dollar estimate" : "")
      + (usage.stale ? "\nCollector data is stale" : "")
      + (root.sourceProblem ? "\n" + root.sourceProblem : "")
    onPressed: function(b) { if (b === Qt.MiddleButton) root.refresh(); else root.toggle() }
  }

  KeyboardPanel {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(root.details ? 370 : 310))
    contentHeight: popup.fittedContentHeight(column.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: { if (root.details) root.showPage(false); else root.close() }
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (dx) root.showPage(dx > 0)
        else if (root.details) {
          root.actionIndex = root.actionIndex === 0 ? 1 : 0
          scroll.contentY = root.actionIndex === 1 ? Math.max(0, scroll.contentHeight - scroll.height) : 0
        }
      }
      onActivateRequested: { if (root.actionIndex === 1 && root.details) root.refresh(); else root.showPage(!root.details) }
      onTextKey: function(t) { if (t.toLowerCase() === "r") root.refresh() }

      Flickable {
        id: scroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        QQC.ScrollBar.vertical: QQC.ScrollBar { policy: QQC.ScrollBar.AsNeeded }

        Column {
          id: column
          width: scroll.width
          spacing: Style.space(14)

          Text {
            text: root.details ? "CODEX FOMO / DETAILS" : "CODEX FOMO"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1.2
          }
          Button {
            width: parent.width
            visible: root.details
            text: "← Back to report"
            foreground: root.foreground
            fontFamily: root.fontFamily
            hasCursor: root.actionIndex === 0
            onHovered: function(hovered) { if (hovered) root.actionIndex = 0 }
            onClicked: root.showPage(false)
          }
          Column {
            width: parent.width
            spacing: Style.space(4)
            Text {
              width: parent.width
              text: root.details ? (root.group && root.group.resetCount ? Model.allowance(root.group.estimatedUnusedWeeklyAllowances) : "—")
                : usage.error ? "—" : Model.money(root.value ? root.value.estimatedUnusedUsd : null)
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
              font.bold: true
            }
            Text {
              width: parent.width
              text: root.details ? "Estimated weekly allowances unused" : Model.reportCaption(usage.summary, usage.error)
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }
          }

          Text {
            width: parent.width
            visible: !root.details && root.group !== null
            text: root.group ? "Since " + Qt.formatDateTime(new Date(root.group.recordingStartedAt), "d MMM yyyy")
              + " · " + root.group.resetCount + (root.group.resetCount === 1 ? " reset" : " resets")
              + (root.value && root.value.unvaluedResetCount > 0 ? "\n" + root.value.unvaluedResetCount + " without a dollar estimate" : "") : ""
            color: Qt.darker(root.foreground, 1.35)
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            visible: usage.error !== "" || usage.stale || root.sourceProblem !== ""
            text: usage.error || (usage.stale ? "Collector data is stale. The last successful poll was more than six minutes ago." : root.sourceProblem)
            textFormat: Text.PlainText
            wrapMode: Text.WrapAnywhere
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Column {
            width: parent.width
            spacing: Style.space(9)
            visible: root.details && root.group !== null
            Repeater {
              model: root.group ? [
                ["Recording since", root.localDate(root.group.recordingStartedAt)],
                ["Plan", root.group.plan],
                ["Recorded resets", String(root.group.resetCount)],
                ["Average unused", root.group.averageUnusedPercent === null ? "—" : root.group.averageUnusedPercent.toFixed(1) + "%"],
                ["Sampling gaps", String(root.group.samplingGapCount)],
                ["Local-only valued resets", String(root.value ? root.value.localOnlyValuedResetCount || 0 : 0)]
              ] : []
              delegate: Row {
                required property var modelData
                width: column.width
                Text {
                  width: parent.width * 0.43
                  text: modelData[0]
                  color: Qt.darker(root.foreground, 1.35)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
                Text {
                  width: parent.width * 0.57
                  text: modelData[1]
                  textFormat: Text.PlainText
                  horizontalAlignment: Text.AlignRight
                  wrapMode: Text.WordWrap
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
              }
            }
          }

          PanelSeparator { width: parent.width; visible: root.details && root.group !== null }
          Column {
            width: parent.width
            spacing: Style.space(5)
            visible: root.details && root.group !== null
            Text {
              text: "Unused API value · " + Model.money(root.value ? root.value.estimatedUnusedUsd : null)
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
            Text {
              width: parent.width
              text: root.value ? root.value.valuedResetCount + " valued resets · " + root.value.unvaluedResetCount + " unvalued" : "No valued resets yet"
              color: Qt.darker(root.foreground, 1.35)
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
            Repeater {
              model: root.calibration && root.calibration.sources ? root.calibration.sources : []
              delegate: Text {
                required property var modelData
                width: column.width
                text: modelData.id + " · " + (modelData.complete ? "Available" : "Incomplete")
                  + (modelData.warnings.length ? "\n" + modelData.warnings.join("\n") : "")
                textFormat: Text.PlainText
                color: modelData.complete ? root.foreground : root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WrapAnywhere
              }
            }
            Text {
              width: parent.width
              text: Model.calibrationLabel(root.calibration)
              textFormat: Text.PlainText
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
            Text {
              width: parent.width
              text: "Estimated from configured native Codex logs at standard API token prices. Unconfigured machines and cloud tasks may be missing."
              color: Qt.darker(root.foreground, 1.35)
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }

          PanelSeparator { width: parent.width; visible: root.observation !== null }
          Column {
            width: parent.width
            spacing: Style.space(7)
            visible: root.observation !== null
            Text {
              text: root.observation ? "This week · " + root.observation.usedPercent + "% used" : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
            Rectangle {
              width: parent.width
              height: Style.space(4)
              radius: height / 2
              color: Qt.alpha(root.foreground, 0.15)
              Rectangle {
                width: parent.width * Math.min(100, Math.max(0, root.observation ? root.observation.usedPercent : 0)) / 100
                height: parent.height
                radius: parent.radius
                color: root.foreground
              }
            }
            Text {
              width: parent.width
              text: "Next reset · " + root.nextReset + (root.details && root.observation ? "\n" + root.localDate(root.observation.resetsAt) : "")
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
            Text {
              visible: root.details
              text: root.observation ? "Last checked " + Model.duration((usage.nowMs - Date.parse(root.observation.checkedAt)) / 1000) + " ago" : ""
              color: Qt.darker(root.foreground, 1.35)
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }

          Text {
            width: parent.width
            visible: root.details && usage.summary !== null
            text: "Estimates use the last sample before each observed reset. Usage between samples is unknown; gaps may hide resets."
              + (usage.summary && usage.summary.groups.length > 1 ? "\nShowing the latest account and plan; other histories remain separate." : "")
            color: Qt.darker(root.foreground, 1.35)
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Button {
            width: parent.width
            visible: !root.details
            text: "View details →"
            foreground: root.foreground
            fontFamily: root.fontFamily
            hasCursor: root.actionIndex === 0
            onClicked: root.showPage(true)
          }
          Button {
            width: parent.width
            visible: root.details
            text: usage.busy ? "Refreshing…" : "Refresh summary"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: !usage.busy
            hasCursor: root.actionIndex === 1
            onHovered: function(hovered) { if (hovered) root.actionIndex = 1 }
            onClicked: root.refresh()
          }
        }
      }
    }
  }
}
