async function refresh() {
  try {
    const response = await fetch('/api/operator/status');
    const status = await response.json();
    if (!response.ok) throw new Error(status.error);
    document.querySelector('#status').textContent = status.backups.error || (!status.backups.configured ? 'Backups are not configured.' : status.backups.lastSuccess && Date.now() - status.backups.lastSuccess < 26 * 3600_000 ? 'Service running. Recent backup available.' : 'No recent successful backup.');
    document.querySelector('#metrics').textContent = JSON.stringify(status, null, 2);
  } catch (error) { document.querySelector('#status').textContent = error.message; }
}
document.querySelector('#backup').addEventListener('click', async () => {
  const response = await fetch('/api/operator/backup', { method: 'POST' });
  document.querySelector('#status').textContent = response.ok ? 'Backup requested. Status will update shortly.' : 'Backup request failed.';
});
refresh(); setInterval(refresh, 10_000);
document.querySelector('#validate-judge').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try {
    document.querySelector('#validation-result').textContent = 'Checking relevance, duplicate answers, and instruction injection…';
    const response = await fetch('/api/operator/validate-judge', { method: 'POST' }), result = await response.json();
    document.querySelector('#validation-result').textContent = !response.ok ? result.error : result.passed ? 'Validation passed. Odd One In is enabled for signed-in channels.' : 'Validation failed. Odd One In remains closed; review the judge before launch.';
    refresh();
  } catch { document.querySelector('#validation-result').textContent = 'The validation connection was interrupted. Check operator status before retrying.'; }
  finally { event.target.disabled = false; }
});
