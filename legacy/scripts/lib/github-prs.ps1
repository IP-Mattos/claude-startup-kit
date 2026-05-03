# GitHub PR queue helper — uses the `gh` CLI to list PRs awaiting your review.
# Returns $null if `gh` is missing or unauthenticated.

function Get-PendingPRs {
    param([int]$Limit = 5)

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $null }

    try {
        # PRs requesting your review across all repos you have access to.
        # `gh search prs` is the lightest way; gh search supports JSON output.
        $json = & gh search prs --review-requested=@me --state=open --limit $Limit --json title,url,repository,author,createdAt 2>$null
        if (-not $json) { return @() }
        $prs = $json | ConvertFrom-Json -ErrorAction Stop
        return @($prs)
    } catch {
        return $null
    }
}
