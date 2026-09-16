(() => {
  const meta = JSON.parse(document.getElementById('review-meta').textContent)
  const storageKey = `alphaview-harness-review:${meta.started_at}`
  const notes = document.getElementById('notes')
  const status = document.getElementById('export-status')
  const labelText = label => label.textContent.trim().replace(/\s+/g, ' ')
  const reviewed = () => Array.from(document.querySelectorAll('.checked-feature input:checked')).map(input => labelText(input.closest('label')))
  const tasks = () => Array.from(document.querySelectorAll('.next-task input:checked')).map(input => ({
    task: labelText(input.closest('label')),
    priority: input.closest('li').querySelector('select').value,
  }))
  const featureReviews = () => Array.from(document.querySelectorAll('.checked-feature input:checked')).map(input => ({
    feature: labelText(input.closest('label')),
    result: input.closest('li').querySelector('.review-result').value,
    note: input.closest('li').querySelector('.review-note').value.trim(),
  }))
  const collect = () => ({ reviewed_features: reviewed(), feature_reviews: featureReviews(), next_tasks: tasks(), notes: notes.value.trim() })
  const updateFeedback = () => {
    for (const input of document.querySelectorAll('.checked-feature input')) {
      const row = input.closest('li')
      row.querySelector('.review-feedback').hidden = !input.checked
      row.querySelector('.review-note').hidden = row.querySelector('.review-result').value !== 'needs_changes'
    }
  }
  for (const label of document.querySelectorAll('.next-task')) {
    const suggested = label.dataset.suggestedPriority || labelText(label).match(/^P[123]/)?.[0]
    if (suggested) label.closest('li').querySelector('select').value = suggested
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (saved && typeof saved === 'object') {
      for (const input of document.querySelectorAll('.checked-feature input'))
        input.checked = Array.isArray(saved.reviewed_features) && saved.reviewed_features.includes(labelText(input.closest('label')))
      for (const input of document.querySelectorAll('.checked-feature input')) {
        const match = Array.isArray(saved.feature_reviews) && saved.feature_reviews.find(item => item && item.feature === labelText(input.closest('label')))
        if (match && ['pass', 'needs_changes'].includes(match.result)) input.closest('li').querySelector('.review-result').value = match.result
        if (match && typeof match.note === 'string') input.closest('li').querySelector('.review-note').value = match.note.slice(0, 800)
      }
      for (const input of document.querySelectorAll('.next-task input')) {
        const match = Array.isArray(saved.next_tasks) && saved.next_tasks.find(item => item && item.task === labelText(input.closest('label')))
        input.checked = Boolean(match)
        if (match && ['P1', 'P2', 'P3'].includes(match.priority)) input.closest('li').querySelector('select').value = match.priority
      }
      if (typeof saved.notes === 'string') notes.value = saved.notes.slice(0, 6000)
    }
  } catch { /* Download remains available without browser storage. */ }
  updateFeedback()
  const save = () => {
    updateFeedback()
    try {
      localStorage.setItem(storageKey, JSON.stringify(collect()))
      status.textContent = '檢閱選擇已暫存於此瀏覽器。匯出 JSON 可交給下一輪 Agent。'
    } catch {
      status.textContent = '瀏覽器無法暫存檢閱，請在離開前匯出 JSON。'
    }
  }
  for (const input of document.querySelectorAll('input[type="checkbox"], select')) input.addEventListener('change', save)
  notes.addEventListener('input', save)
  for (const note of document.querySelectorAll('.review-note')) note.addEventListener('input', save)
  document.getElementById('export').addEventListener('click', () => {
    const review = collect()
    if (!review.reviewed_features.length && !review.next_tasks.length && !review.notes) {
      status.textContent = '請先勾選項目或填寫備註。'
      return
    }
    const payload = {format_version: 3, project: 'AlphaView', harness: meta, ...review, exported_at: new Date().toISOString()}
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url
    link.download = 'alphaview-harness-review.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    status.textContent = '已下載 Review 與優先順序；此檔不會自動開始下一輪開發。'
  })
})()
