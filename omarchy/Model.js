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
  var group = activeGroup(data);
  if (error || !group || !group.value || !finite(group.value.estimatedUnusedUsd)) return "$—";
  return money(group.value.estimatedUnusedUsd) + (group.value.unvaluedResetCount > 0 ? "*" : "");
}

function reportCaption(data, error) {
  if (error) return "Summary unavailable";
  if (!data) return "Loading usage…";
  var group = activeGroup(data);
  if (!group) return "Waiting for the first usage sample";
  if (!group.resetCount) return "Awaiting first reset";
  if (!group.value || !finite(group.value.estimatedUnusedUsd)) return "No dollar estimate yet";
  return "Estimated wasted API value" + (group.value.unvaluedResetCount > 0 ? " · partial" : "");
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
  if (calibration.reason === "incomplete-scan") return "Calibration paused: a token source is incomplete.";
  if (calibration.reason === "no-local-usage") return "Quota changed without matching local token usage.";
  return "Calibrating · " + calibration.quotaUsedPercent.toFixed(1) + " / " + calibration.minimumQuotaPercent + " percentage points observed";
}

function sourceProblem(calibration) {
  if (!calibration || calibration.scanComplete !== false) return "";
  var sources = calibration.sources || [];
  var missing = sources.filter(function(s) { return !s.complete; }).map(function(s) { return s.id; });
  return "USD calibration paused" + (missing.length ? " · " + missing.join(", ") + " unavailable or incomplete" : " · incomplete token coverage");
}
