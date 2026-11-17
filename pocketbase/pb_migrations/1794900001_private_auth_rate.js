migrate((app) => {
  // Devices behind Serve share the proxy IP. Allow normal sign-in/refresh bursts.
  const settings = app.settings()
  settings.rateLimits.rules = settings.rateLimits.rules.map((rule) => {
    if (rule.label === '*:auth') {
      rule.duration = 60
      rule.maxRequests = 20
    }
    return rule
  })
  app.save(settings)
})
