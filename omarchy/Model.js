function finite(value) { return typeof value === "number" && isFinite(value); }
function validDate(value) { return typeof value === "string" && isFinite(Date.parse(value)); }

function parseSummary(text) {
  var response = JSON.parse(text);
  if (!response || response.schemaVersion !== 1) throw new Error("Unsupported Codex usage response version.");
  if (!response.ok) throw new Error(response.error && response.error.message || "Unable to read Codex usage.");
  var data = response.data;
  if (response.command !== "summary" || !data || !Array.isArray(data.groups)) throw new Error("Invalid Codex usage summary.");
  for (var i = 0; i < data.groups.length; i++) {
    var group = data.groups[i];
    if (!group || typeof group.accountId !== "string" || typeof group.plan !== "string" ||
        !finite(group.resetCount) || group.resetCount < 0 ||
        !finite(group.estimatedUnusedWeeklyAllowances) || group.estimatedUnusedWeeklyAllowances < 0 ||
        !finite(group.samplingGapCount) || group.samplingGapCount < 0 ||
        !validDate(group.recordingStartedAt) ||
        (group.resetCount > 0 && !finite(group.averageUnusedPercent))) throw new Error("Invalid Codex usage totals.");
    if (group.value) {
      var value = group.value;
      if ((value.estimatedUnusedUsd !== null && (!finite(value.estimatedUnusedUsd) || value.estimatedUnusedUsd < 0)) ||
          !finite(value.valuedResetCount) || !finite(value.unvaluedResetCount) ||
          value.valuedResetCount < 0 || value.unvaluedResetCount < 0) throw new Error("Invalid API value totals.");
      var cal = value.currentCalibration;
      if (cal && (typeof cal.reason !== "string" || !finite(cal.quotaUsedPercent) || !finite(cal.minimumQuotaPercent) ||
          (cal.weeklyApiValueUsd !== null && (!finite(cal.weeklyApiValueUsd) || cal.weeklyApiValueUsd < 0)))) throw new Error("Invalid API calibration.");
    }
  }
  if (data.observation !== null) {
    var sample = data.observation;
    if (!sample || !finite(sample.usedPercent) || !finite(sample.remainingPercent) ||
        !validDate(sample.checkedAt) || !validDate(sample.resetsAt) || !activeGroup(data))
      throw new Error("Invalid Codex usage observation.");
  } else if (data.groups.length) throw new Error("Summary is missing its latest observation.");
  return data;
}

function activeGroup(data) {
  if (!data || !data.observation) return null;
  for (var i = 0; i < data.groups.length; i++) {
    var group = data.groups[i];
    if (group.accountId === data.observation.accountId && group.plan === data.observation.plan) return group;
  }
  return null;
}

function allowance(value) { return value.toFixed(2) + "×"; }

function barLabel(data, error) {
  if (error) return "Codex · unavailable";
  if (!data) return "Codex · …";
  var group = activeGroup(data);
  if (!group) return "Codex · no data";
  if (!group.resetCount) return "Codex · awaiting reset";
  return "Codex · " + allowance(group.estimatedUnusedWeeklyAllowances) + " unused";
}

function duration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h " + Math.floor(seconds % 3600 / 60) + "m";
  return Math.floor(seconds / 86400) + "d " + Math.floor(seconds % 86400 / 3600) + "h";
}

function stale(data, now) {
  return !!(data && data.observation && now - Date.parse(data.observation.checkedAt) > 360000);
}

function money(value) { return finite(value) ? "$" + value.toFixed(2) : "—"; }

function calibrationLabel(calibration) {
  if (!calibration) return "Calibration starts at the next poll.";
  if (calibration.weeklyApiValueUsd !== null && finite(calibration.weeklyApiValueUsd))
    return "Weekly API equivalent ≈ " + money(calibration.weeklyApiValueUsd) + "\nBased on " + calibration.quotaUsedPercent.toFixed(1) + " percentage points of quota.";
  if (calibration.reason === "unpriced-models") return "Calibration unavailable: some models have no API price.";
  if (calibration.reason === "incomplete-scan") return "Calibration unavailable: local token scan incomplete.";
  if (calibration.reason === "no-local-usage") return "Quota changed without matching local token usage.";
  return "Calibrating · " + calibration.quotaUsedPercent.toFixed(1) + " / " + calibration.minimumQuotaPercent + " percentage points observed";
}
