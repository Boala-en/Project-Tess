import { useEffect, useState } from 'react'
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight,
  Check, ChevronDown, CircleHelp, CircleUserRound, FileClock, Fingerprint,
  Home, LockKeyhole, LogOut, Menu, Moon, MoreHorizontal, Plus, ShieldCheck,
  Sun, Wallet, X,
} from 'lucide-react'
import './App.css'

type WalletKind = 'general' | 'trading' | 'staking'
type WalletRow = { kind: WalletKind; cents: number }
type SessionUser = {
  id: string; displayName: string; identifier: string; role: string
  referralCode: string; identityStatus: string; wallets: WalletRow[]
  claim: { ledgerId: string; claimedAt: string } | null; locked: boolean; csrfToken: string
}
type Transaction = {
  id: string; kind: string; wallet: string; amountCents: number; feeCents: number
  status: string; reference: string; details: string; createdAt: string
}
type Page = 'Overview' | 'Wallets' | 'Deposit' | 'Transfer' | 'Withdraw' | 'Trade' | 'Stake' | 'Referrals' | 'Activity' | 'Verification' | 'Settings' | 'Administration'
type Theme = 'light' | 'dark' | 'system'

const primaryPages: Page[] = ['Overview', 'Wallets', 'Deposit', 'Activity']
const morePages: Page[] = ['Transfer', 'Withdraw', 'Trade', 'Stake', 'Referrals', 'Verification', 'Settings']
const money = (cents = 0) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

function PageIcon({ page, size = 19 }: { page: Page; size?: number }) {
  switch (page) {
    case 'Overview': return <Home size={size} />
    case 'Wallets': return <Wallet size={size} />
    case 'Deposit': return <ArrowDownLeft size={size} />
    case 'Transfer': return <ArrowLeftRight size={size} />
    case 'Withdraw': return <ArrowUpRight size={size} />
    case 'Trade': return <Activity size={size} />
    case 'Stake': return <ShieldCheck size={size} />
    case 'Referrals': return <CircleUserRound size={size} />
    case 'Activity': return <FileClock size={size} />
    case 'Verification': return <Fingerprint size={size} />
    case 'Settings': return <Menu size={size} />
    case 'Administration': return <LockKeyhole size={size} />
  }
}

async function request<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.method && init.method !== 'GET' ? { 'X-CSRF-Token': token } : {}), ...init?.headers },
  })
  if (response.status === 204) return undefined as T
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'Something went wrong. Please try again.')
  return body
}

function App() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [csrf, setCsrf] = useState('')
  const [page, setPage] = useState<Page>('Overview')
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('tess-theme') as Theme | null) ?? 'system')
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [confirmClaim, setConfirmClaim] = useState(false)
  const [claimBusy, setClaimBusy] = useState(false)
  const [transferBusy, setTransferBusy] = useState(false)
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('tess-theme', theme)
  }, [theme])

  const refreshUser = async (token = csrf) => {
    const next = await request<SessionUser>('/api/auth/me', token)
    setUser(next)
    setCsrf(next.csrfToken)
    setLocked(next.locked)
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const csrfResponse = await fetch('/api/csrf', { credentials: 'same-origin' }).then((response) => response.json() as Promise<{ token: string }>)
        if (!alive) return
        setCsrf(csrfResponse.token)
        try {
          const current = await request<SessionUser>('/api/auth/me', csrfResponse.token)
          if (alive) { setUser(current); setCsrf(current.csrfToken); setLocked(current.locked) }
        } catch (authError) {
          if (authError instanceof Error && authError.message.includes('Unlock')) setLocked(true)
        }
      } catch { if (alive) setError('The local demo service is not available. Start the API and refresh.') }
      finally { if (alive) setBusy(false) }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!user || locked || page !== 'Activity') return
    void request<Transaction[]>('/api/transactions', csrf).then(setTransactions).catch((reason: Error) => setError(reason.message))
  }, [user, locked, page, csrf])

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3200) }
  const changePage = (next: Page) => { setPage(next); setShowMore(false); setError('') }
  const balanceFor = (kind: WalletKind) => user?.wallets.find((wallet) => wallet.kind === kind)?.cents ?? 0
  const total = balanceFor('general') + balanceFor('trading') + balanceFor('staking')

  const handleAuth = async (values: Record<string, string>, mode: 'register' | 'login') => {
    setError('')
    try {
      const result = await request<{ csrfToken: string }>(`/api/auth/${mode}`, csrf, { method: 'POST', body: JSON.stringify(values) })
      await refreshUser(result.csrfToken)
      setLocked(false)
      setPage('Overview')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sign in.') }
  }

  const claimDemoFunds = async () => {
    setClaimBusy(true)
    setError('')
    try {
      const result = await request<{ claimed: boolean; message: string }>('/api/deposits/demo-claim', csrf, { method: 'POST', body: '{}' })
      await refreshUser()
      setConfirmClaim(false)
      if (result.claimed) { notify('Your $1,000 demo funds are ready.'); changePage('Activity') }
      else notify('This account has already received its demo funds.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not add demo funds.') }
    finally { setClaimBusy(false) }
  }

  const submitTransfer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    setTransferBusy(true)
    setError('')
    try {
      await request('/api/transfers', csrf, { method: 'POST', body: JSON.stringify({ from: values.get('from'), to: values.get('to'), amount: values.get('amount') }) })
      await refreshUser()
      form.reset()
      notify('Transfer complete. Balances updated.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Transfer could not be completed.') }
    finally { setTransferBusy(false) }
  }

  const lockSession = async () => {
    try { await request('/api/auth/lock', csrf, { method: 'POST', body: '{}' }); setLocked(true) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not lock session.') }
  }
  const logOut = async () => {
    try { await request('/api/auth/logout', csrf, { method: 'POST', body: '{}' }) }
    finally { setUser(null); setLocked(false); setPage('Overview') }
  }

  if (busy) return <div className="app-loading" role="status">Opening your demo workspace...</div>
  if (!user) return <AuthScreen onSubmit={handleAuth} csrf={csrf} error={error} />
  if (locked) return <UnlockScreen csrf={csrf} onUnlock={async (pin) => {
    try { await request('/api/auth/unlock', csrf, { method: 'POST', body: JSON.stringify({ pin }) }); setLocked(false); await refreshUser() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'PIN is incorrect.') }
  }} onLogout={logOut} error={error} userName={user.displayName} />

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); changePage('Overview') }}><span className="brand-mark">t</span><span>Tess<span className="brand-light">Protocol</span></span></a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">{[...primaryPages, ...morePages, ...(user.role === 'admin' ? ['Administration' as Page] : [])].map((item) => <NavItem key={item} item={item} active={page === item} onClick={() => changePage(item)} />)}</nav>
        <div className="sidebar-bottom"><SimulationTag /><button className="profile-mini" type="button" onClick={() => changePage('Settings')}><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>Personal account</small></span><ChevronDown size={16} /></button></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div className="crumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{page}</strong></div><div className="top-actions"><SimulationTag /><button className="icon-button theme-toggle" title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Change theme`} onClick={() => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')}><ThemeIcon theme={theme} /></button><button className="avatar avatar-button" aria-label="Account settings" onClick={() => changePage('Settings')}>{user.displayName.slice(0, 1).toUpperCase()}</button></div></header>
        <div className="page-content">
          {error && <div className="inline-alert" role="alert"><CircleHelp size={17} />{error}<button aria-label="Dismiss message" onClick={() => setError('')}><X size={16} /></button></div>}
          {page === 'Overview' && <Overview user={user} total={total} balanceFor={balanceFor} onNavigate={changePage} />}
          {page === 'Deposit' && <Deposit user={user} onClaim={() => setConfirmClaim(true)} onActivity={() => changePage('Activity')} />}
          {page === 'Wallets' && <Wallets balanceFor={balanceFor} onNavigate={changePage} />}
          {page === 'Transfer' && <TransferForm balanceFor={balanceFor} onSubmit={submitTransfer} busy={transferBusy} />}
          {page === 'Activity' && <ActivityPage transactions={transactions} onDeposit={() => changePage('Deposit')} />}
          {page === 'Settings' && <Settings user={user} theme={theme} setTheme={setTheme} onLock={lockSession} onLogout={logOut} />}
          {page === 'Withdraw' && <ComingSoon title="Withdraw" eyebrow="GENERAL WALLET" text="Withdrawals are disabled until your identity review is approved. This demo never sends money or connects to a payment provider." action="Start identity review" onClick={() => changePage('Verification')} />}
          {page === 'Verification' && <Verification status={user.identityStatus} />}
          {page === 'Trade' && <ComingSoon title="Trade simulation" eyebrow="TRADING WALLET" text="Manual simulations use provisional demo assumptions, not market data, exchange execution, or guaranteed returns." action="View your wallet" onClick={() => changePage('Wallets')} />}
          {page === 'Stake' && <ComingSoon title="Staking" eyebrow="14-DAY DEMO TERM" text="Staking principal is locked for 14 days in this provisional simulation. Early redemption and compounding are not enabled." action="Review balances" onClick={() => changePage('Wallets')} />}
          {page === 'Referrals' && <Referrals code={user.referralCode} />}
          {page === 'Administration' && <ComingSoon title="Administrator review" eyebrow="RESTRICTED AREA" text="Identity review is available only to a separately created local administrator account." action="Return to overview" onClick={() => changePage('Overview')} />}
        </div>
        <footer className="page-footer"><span>© 2026 Tess Protocol</span><span>Simulation only · No real funds or transactions</span></footer>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">{primaryPages.map((item) => <MobileNavItem key={item} item={item} active={page === item} onClick={() => changePage(item)} />)}<button className={`mobile-nav-item ${showMore || morePages.includes(page) ? 'active' : ''}`} type="button" aria-expanded={showMore} onClick={() => setShowMore((open) => !open)}><MoreHorizontal size={21} /><span>More</span></button></nav>
      {showMore && <><button className="scrim" aria-label="Close more menu" onClick={() => setShowMore(false)} /><div className="more-sheet" role="dialog" aria-label="More destinations"><div className="sheet-header"><span className="sheet-handle" /><button className="icon-button" type="button" aria-label="Close destinations" onClick={() => setShowMore(false)}><X size={18} /></button></div>{morePages.map((item) => <NavItem key={item} item={item} active={page === item} onClick={() => changePage(item)} />)}{user.role === 'admin' && <NavItem item="Administration" active={page === 'Administration'} onClick={() => changePage('Administration')} />}</div></>}
      {confirmClaim && <ClaimDialog busy={claimBusy} onCancel={() => setConfirmClaim(false)} onConfirm={claimDemoFunds} />}
      {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
    </div>
  )
}

function AuthScreen({ onSubmit, csrf, error }: { onSubmit: (values: Record<string, string>, mode: 'register' | 'login') => Promise<void>; csrf: string; error: string }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true)
    const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>
    await onSubmit(values, mode); setBusy(false)
  }
  return <div className="auth-layout"><section className="auth-aside"><a className="brand" href="#"><span className="brand-mark">t</span><span>Tess<span className="brand-light">Protocol</span></span></a><div className="auth-message"><span className="eyebrow">YOUR PERSONAL DEMO WALLET</span><h1>Make room for<br />better money habits.</h1><p>Explore wallet tools in a private, simulated environment. No funds move. Nothing here has monetary value.</p><div className="auth-aside-foot"><SimulationTag /><span>Built for practice, not payment.</span></div></div><div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" /></section>
    <section className="auth-panel"><div className="auth-form-wrap"><div className="auth-mobile-brand"><a className="brand" href="#"><span className="brand-mark">t</span><span>Tess<span className="brand-light">Protocol</span></span></a><SimulationTag /></div><div className="auth-heading"><span className="eyebrow">{mode === 'login' ? 'WELCOME BACK' : 'CREATE YOUR ACCOUNT'}</span><h2>{mode === 'login' ? 'Sign in to Tess' : 'Set up your account'}</h2><p>{mode === 'login' ? 'Use your email or phone and password.' : 'A few details, then your demo workspace is ready.'}</p></div>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      <form className="form-stack" onSubmit={submit}>
        {mode === 'register' && <label>Display name<input required name="displayName" autoComplete="name" minLength={2} maxLength={60} placeholder="Your name" /></label>}
        <label>Email or phone<input required name="identifier" autoComplete={mode === 'login' ? 'username' : 'email'} placeholder="name@example.com or +233…" /></label>
        <label>Account password<input required name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : 1} placeholder={mode === 'register' ? 'At least 12 characters' : 'Your password'} /></label>
        {mode === 'register' && <><label>Six-digit unlock PIN<input required name="pin" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" placeholder="6 digits" /></label><label>Confirm unlock PIN<input required name="pinConfirmation" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" placeholder="Enter PIN again" /></label><label>Withdrawal password<input required name="withdrawalPassword" type="password" autoComplete="new-password" minLength={12} placeholder="Different from account password" /></label><label>Confirm withdrawal password<input required name="withdrawalPasswordConfirmation" type="password" autoComplete="new-password" minLength={12} placeholder="Enter password again" /></label><label className="optional-label">Referral code <span>Optional</span><input name="referralCode" autoComplete="off" placeholder="TESS-XXXXXXXX" /></label><p className="form-footnote">This demo does not verify email or phone ownership. Keep your unlock PIN separate from your password.</p></>}
        <button className="button button-primary full-button" disabled={busy || !csrf}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}<ArrowRight size={17} /></button>
      </form>
      <p className="auth-switch">{mode === 'login' ? 'New to Tess?' : 'Already have an account?'} <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></p><div className="auth-legal"><ShieldCheck size={15} />Hashed credentials · No real deposits, trading, or payouts</div>
    </div></section></div>
}

function Overview({ user, total, balanceFor, onNavigate }: { user: SessionUser; total: number; balanceFor: (kind: WalletKind) => number; onNavigate: (page: Page) => void }) {
  return <><div className="welcome-row"><div><span className="eyebrow">YOUR TESS WORKSPACE</span><h1>Good to see you, {user.displayName.split(' ')[0]}.</h1><p>Your personal simulated wallet, all in one place.</p></div><button className="button button-secondary desktop-add" onClick={() => onNavigate('Deposit')}><Plus size={17} />Add demo funds</button></div>
    <section className="balance-hero"><div className="balance-hero-top"><span className="overline">TOTAL SIMULATED BALANCE <span className="sim-dot" /></span><span className="simulation-pill">DEMO USD</span></div><div className="total-balance">{money(total)}</div><div className="balance-foot"><span>Across 3 wallets</span><span className="balance-foot-sep" /><span>USD · Simulated</span></div><div className="hero-actions"><button className="button hero-button" onClick={() => onNavigate('Deposit')}><ArrowDownLeft size={17} />Add demo funds</button><button className="button hero-button-quiet" onClick={() => onNavigate('Transfer')}><ArrowLeftRight size={17} />Transfer</button></div><div className="glass-ring ring-a" /><div className="glass-ring ring-b" /></section>
    <div className="section-heading"><div><span className="eyebrow">YOUR MONEY, ORGANIZED</span><h2>Wallets</h2></div><button className="text-button" onClick={() => onNavigate('Wallets')}>All wallets <ArrowRight size={15} /></button></div><div className="wallet-grid">{(['general', 'trading', 'staking'] as const).map((kind, index) => <WalletCard key={kind} kind={kind} cents={balanceFor(kind)} index={index} />)}</div>
    <div className="overview-lower"><section className="activity-preview"><div className="section-heading compact"><div><span className="eyebrow">LATEST</span><h2>Recent activity</h2></div><button className="text-button" onClick={() => onNavigate('Activity')}>See all <ArrowRight size={15} /></button></div><div className="empty-activity"><span className="empty-icon"><FileClock size={20} /></span><div><strong>Nothing here yet</strong><p>Your wallet activity will show here.</p></div></div></section>
      <section className="checklist"><div className="section-heading compact"><div><span className="eyebrow">GETTING STARTED</span><h2>Your checklist</h2></div></div><ChecklistRow done title="Account created" text="Your demo profile is ready." /><ChecklistRow done={Boolean(user.claim)} title="Add demo starting funds" text={user.claim ? 'One-time claim completed.' : 'Claim your one-time demo balance.'} action={!user.claim ? () => onNavigate('Deposit') : undefined} /><ChecklistRow done={user.identityStatus === 'approved'} title="Identity review" text={user.identityStatus === 'approved' ? 'Review approved.' : 'Required before demo withdrawals.'} action={user.identityStatus === 'approved' ? undefined : () => onNavigate('Verification')} /></section></div>
    <div className="notice-strip"><ShieldCheck size={18} /><span><strong>Simulation environment.</strong> Balances and activity are fictional and have no real monetary value.</span><button aria-label="Learn about the simulation" onClick={() => onNavigate('Deposit')}><ArrowRight size={16} /></button></div>
  </>
}

function WalletCard({ kind, cents, index }: { kind: WalletKind; cents: number; index: number }) {
  const label = kind[0].toUpperCase() + kind.slice(1)
  const Icon = kind === 'general' ? Wallet : kind === 'trading' ? Activity : ShieldCheck
  return <article className={`wallet-card wallet-card-${kind}`}><div className="wallet-card-top"><span className={`wallet-icon icon-${kind}`}><Icon size={18} /></span><span className="wallet-index">0{index + 1}</span></div><div className="wallet-card-name">{label}</div><div className="wallet-card-amount">{money(cents)}</div><div className="wallet-card-bottom"><span>{kind === 'general' ? 'Available to allocate' : kind === 'trading' ? 'Available for simulations' : 'Locked in demo terms'}</span><span className="wallet-dot" /></div></article>
}

function Deposit({ user, onClaim, onActivity }: { user: SessionUser; onClaim: () => void; onActivity: () => void }) {
  const claimed = Boolean(user.claim)
  return <div className="narrow-page"><PageHeading eyebrow="GENERAL WALLET" title="Add demo funds" description="A one-time starting balance for exploring Tess. This is not a deposit and cannot be converted to real money." /><section className="demo-offer"><div className="offer-label"><span className="offer-spark" /><span>ONE-TIME STARTER CREDIT</span></div><div className="offer-amount">$1,000</div><p>Simulated USD · Added to your General wallet</p><div className="offer-rule" /><div className="offer-includes"><span><Check size={15} />No payment details</span><span><Check size={15} />No monetary value</span></div>{claimed ? <div className="claim-complete"><button className="button button-complete" disabled><Check size={17} />$1,000 demo funds added</button><button className="text-button transaction-link" onClick={onActivity}>View transaction details <ArrowRight size={15} /></button></div> : <button className="button button-primary claim-button" onClick={onClaim}><Plus size={18} />Start demo with $1,000<ArrowRight className="button-trailing" size={17} /></button>}</section><div className="safety-note"><span className="safety-icon"><ShieldCheck size={18} /></span><div><strong>Demo funds are not real money</strong><p>We will credit $1,000 in simulated USD to your General wallet once. Claim status is saved to your account and cannot be reset, even if the balance is spent or withdrawn.</p></div></div><div className="deposit-footnote"><span className="sim-dot" />This one-time demo credit is distinct from a real deposit. No payment provider or bank is connected.</div></div>
}

function ClaimDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}><section className="dialog claim-dialog" role="dialog" aria-modal="true" aria-labelledby="claim-title"><button className="dialog-close icon-button" aria-label="Close confirmation" onClick={onCancel} disabled={busy}><X size={19} /></button><span className="dialog-icon"><Wallet size={21} /></span><span className="eyebrow">CONFIRM DEMO CREDIT</span><h2 id="claim-title">Start with $1,000?</h2><p>This one-time simulated credit will be added to your General wallet. It has no real monetary value, cannot be paid out, and will not be restored if spent.</p><div className="confirm-breakdown"><span>Demo starting funds</span><strong>$1,000.00</strong></div><div className="dialog-actions"><button className="button button-secondary" onClick={onCancel} disabled={busy}>Not now</button><button className="button button-primary" onClick={onConfirm} disabled={busy}>{busy ? 'Adding…' : 'Confirm demo funds'}{!busy && <ArrowRight size={16} />}</button></div></section></div>
}

function Wallets({ balanceFor, onNavigate }: { balanceFor: (kind: WalletKind) => number; onNavigate: (page: Page) => void }) {
  return <><PageHeading eyebrow="YOUR BALANCES" title="Wallets" description="Three separate places for your simulated USD. Balances update after each demo action." /><div className="wallet-grid wallet-grid-large">{(['general', 'trading', 'staking'] as const).map((kind, index) => <WalletCard key={kind} kind={kind} cents={balanceFor(kind)} index={index} />)}</div><section className="wallet-actions"><h2>Move between wallets</h2><p>Transfer available demo balance between General and Trading. Staking uses its own 14-day lock workflow.</p><button className="button button-secondary" onClick={() => onNavigate('Transfer')}><ArrowLeftRight size={17} />Transfer between wallets</button></section></>
}

function TransferForm({ balanceFor, onSubmit, busy }: { balanceFor: (kind: WalletKind) => number; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; busy: boolean }) {
  const [from, setFrom] = useState('general')
  const to = from === 'general' ? 'trading' : 'general'
  return <div className="narrow-page"><PageHeading eyebrow="GENERAL ↔ TRADING" title="Transfer demo funds" description="Move simulated USD between wallets. Staking balances cannot be transferred." /><form className="workflow-form" onSubmit={onSubmit}><label>From<select name="from" value={from} onChange={(event) => setFrom(event.target.value)}><option value="general">General · {money(balanceFor('general'))}</option><option value="trading">Trading · {money(balanceFor('trading'))}</option></select></label><div className="transfer-direction"><span className="direction-line" /><span className="direction-icon"><ArrowDownLeft size={17} /></span><span className="direction-line" /></div><label>To<input value={`${to[0].toUpperCase()}${to.slice(1)} · ${money(balanceFor(to))}`} disabled /></label><label>Amount<input name="amount" required inputMode="decimal" type="number" min="0.01" step="0.01" placeholder="0.00" /><span className="field-hint">Available: {money(balanceFor(from as WalletKind))}</span></label><div className="summary-line"><span>Transfer fee</span><strong>$0.00</strong></div><button className="button button-primary full-button" disabled={busy}>{busy ? 'Transferring…' : 'Review and transfer'}<ArrowRight size={17} /></button></form><div className="safety-note"><span className="safety-icon"><ShieldCheck size={18} /></span><div><strong>Protected by server-side balance checks</strong><p>Transfers are recorded in the demo ledger and cannot make a wallet balance negative.</p></div></div></div>
}

function ActivityPage({ transactions, onDeposit }: { transactions: Transaction[]; onDeposit: () => void }) {
  return <><PageHeading eyebrow="YOUR HISTORY" title="Activity" description="Every simulated wallet action, timestamped and recorded." />{transactions.length === 0 ? <div className="activity-empty-page"><span className="empty-icon"><FileClock size={23} /></span><h2>No transactions yet</h2><p>Your demo credit, transfers, and future activity will appear here.</p><button className="button button-secondary" onClick={onDeposit}><Plus size={16} />Start demo with $1,000</button></div> : <div className="transactions">{transactions.map((transaction) => { const details = JSON.parse(transaction.details || '{}') as { label?: string; from?: string; to?: string }; const timestamp = transaction.createdAt.endsWith('Z') ? transaction.createdAt : `${transaction.createdAt}Z`; return <details className="transaction-row" key={transaction.id}><summary><span className="transaction-icon"><ArrowDownLeft size={17} /></span><span className="transaction-main"><strong>{details.label ?? transaction.kind.replaceAll('_', ' ')}</strong><small>{new Date(timestamp).toLocaleString()} · {transaction.wallet}</small></span><strong className={transaction.amountCents >= 0 ? 'amount-positive' : ''}>{transaction.amountCents >= 0 ? '+' : '−'}{money(Math.abs(transaction.amountCents))}</strong><span className="status-pill">{transaction.status}</span></summary><div className="transaction-details"><span>Reference <strong>{transaction.reference}</strong></span><span>Fee <strong>{money(transaction.feeCents)}</strong></span>{details.from && <span>From / To <strong>{details.from} → {details.to}</strong></span>}</div></details> })}</div>}</>
}

function Settings({ user, theme, setTheme, onLock, onLogout }: { user: SessionUser; theme: Theme; setTheme: (theme: Theme) => void; onLock: () => void; onLogout: () => void }) {
  return <><PageHeading eyebrow="ACCOUNT PREFERENCES" title="Settings" description="Manage your display, session, and account security." /><section className="settings-section"><div className="settings-section-title"><span className="settings-icon"><CircleUserRound size={19} /></span><div><h2>Profile</h2><p>Basic information for this local demo account.</p></div></div><div className="settings-row"><span>Display name</span><strong>{user.displayName}</strong></div><div className="settings-row"><span>Email or phone</span><strong>{user.identifier}</strong></div><div className="settings-row"><span>Contact ownership</span><span className="muted-state">Not verified</span></div></section><section className="settings-section"><div className="settings-section-title"><span className="settings-icon"><Sun size={19} /></span><div><h2>Appearance</h2><p>Choose how Tess looks on this device.</p></div></div><div className="theme-options">{(['light', 'dark', 'system'] as const).map((option) => <button className={`theme-option ${theme === option ? 'selected' : ''}`} key={option} onClick={() => setTheme(option)} aria-pressed={theme === option}>{option === 'light' ? <Sun size={17} /> : option === 'dark' ? <Moon size={17} /> : <Menu size={17} />}{option[0].toUpperCase() + option.slice(1)}{theme === option && <Check size={15} />}</button>)}</div></section><section className="settings-section"><div className="settings-section-title"><span className="settings-icon"><LockKeyhole size={19} /></span><div><h2>Security</h2><p>Passwords are hashed. Your session expires after 8 hours.</p></div></div><div className="settings-row"><span>Session protection</span><span className="security-good"><Check size={14} /> Enabled</span></div><div className="settings-actions"><button className="button button-secondary" onClick={onLock}><LockKeyhole size={16} />Lock session</button><button className="button button-danger" onClick={onLogout}><LogOut size={16} />Sign out</button></div></section><div className="settings-warning"><ShieldCheck size={17} /><span>Account recovery without verified email or phone is an unresolved product decision. No password reset bypass is available in this demo.</span></div></>
}

function Verification({ status }: { status: string }) {
  return <div className="narrow-page"><PageHeading eyebrow="IDENTITY REVIEW" title="Verify your identity" description="Withdrawals are unavailable until your submission is approved. Your account and demo wallets remain usable." /><div className="verification-status"><span className={`status-dot status-${status}`} /><div><strong>{status.replace('_', ' ').replace(/^./, (letter) => letter.toUpperCase())}</strong><p>{status === 'approved' ? 'Your demo review was approved.' : status === 'pending' ? 'A local administrator is reviewing the sample materials.' : status === 'rejected' ? 'Review rejected. You may submit again with sample images.' : 'No documents submitted.'}</p></div></div><div className="upload-panel"><Fingerprint size={24} /><h2>Sample images only</h2><p>Use clearly fictional sample images for this local prototype. Do not upload a real Ghana Card or selfie.</p><button className="button button-secondary" disabled><Plus size={16} />Upload flow not available</button></div><div className="safety-note"><span className="safety-icon"><ShieldCheck size={18} /></span><div><strong>Manual demo review is not identity verification</strong><p>It does not establish document authenticity or perform authoritative identity or biometric checks.</p></div></div></div>
}

function Referrals({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const share = `${window.location.origin}/?ref=${code}`
  return <div className="narrow-page"><PageHeading eyebrow="GROW YOUR DEMO CIRCLE" title="Referrals" description="Invite someone to create their own simulated account." /><section className="referral-panel"><span className="eyebrow">YOUR PERSONAL CODE</span><div className="referral-code">{code}</div><button className="button button-secondary" onClick={() => { void navigator.clipboard.writeText(share).then(() => setCopied(true)) }}>{copied ? <Check size={16} /> : <Plus size={16} />}{copied ? 'Link copied' : 'Copy invite link'}</button></section><div className="safety-note"><span className="safety-icon"><CircleHelp size={18} /></span><div><strong>Referral commissions are disabled</strong><p>This demo tracks attribution only and does not pay rewards. Rate, basis, tiers, eligibility, and funding need product decisions.</p></div></div></div>
}

function ComingSoon({ title, eyebrow, text, action, onClick }: { title: string; eyebrow: string; text: string; action: string; onClick: () => void }) {
  return <div className="narrow-page"><PageHeading eyebrow={eyebrow} title={title} description={text} /><div className="empty-workflow"><span className="empty-icon"><CircleHelp size={23} /></span><h2>Demo workflow preview</h2><p>This workflow is not enabled in this local release. No real-world transaction takes place.</p><button className="button button-secondary" onClick={onClick}>{action}<ArrowRight size={16} /></button></div></div>
}
function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <div className="page-heading"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div> }
function ChecklistRow({ done, title, text, action }: { done: boolean; title: string; text: string; action?: () => void }) { return <div className="checklist-row"><span className={`checklist-mark ${done ? 'checked' : ''}`}>{done && <Check size={13} />}</span><div><strong>{title}</strong><p>{text}</p></div>{action && <button className="checklist-action" aria-label={`Continue: ${title}`} onClick={action}><ArrowRight size={16} /></button>}</div> }
function NavItem({ item, active, onClick }: { item: Page; active: boolean; onClick: () => void }) { return <button className={`side-nav-item ${active ? 'active' : ''}`} type="button" onClick={onClick}><PageIcon page={item} /><span>{item}</span>{active && <span className="nav-current" />}</button> }
function MobileNavItem({ item, active, onClick }: { item: Page; active: boolean; onClick: () => void }) { return <button className={`mobile-nav-item ${active ? 'active' : ''}`} type="button" onClick={onClick}><PageIcon page={item} size={20} /><span>{item}</span></button> }
function SimulationTag() { return <span className="simulation-tag"><span className="sim-dot" />DEMO MODE</span> }
function ThemeIcon({ theme }: { theme: Theme }) { return theme === 'light' ? <Sun size={19} /> : theme === 'dark' ? <Moon size={18} /> : <Menu size={19} /> }
function UnlockScreen({ csrf, onUnlock, onLogout, error, userName }: { csrf: string; onUnlock: (pin: string) => void; onLogout: () => void; error: string; userName: string }) {
  const [pin, setPin] = useState('')
  return <main className="unlock-screen"><div className="unlock-brand"><span className="brand-mark">t</span><span>Tess<span className="brand-light">Protocol</span></span></div><span className="unlock-icon"><LockKeyhole size={22} /></span><span className="eyebrow">SESSION LOCKED</span><h1>Welcome back, {userName.split(' ')[0]}.</h1><p>Enter your six-digit PIN to unlock this session.</p><form onSubmit={(event) => { event.preventDefault(); onUnlock(pin) }}><input aria-label="Six-digit unlock PIN" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" value={pin} onChange={(event) => setPin(event.target.value)} /><button className="button button-primary full-button" disabled={!csrf || pin.length !== 6}>Unlock with PIN<ArrowRight size={16} /></button></form>{error && <div className="inline-alert" role="alert">{error}</div>}<button className="text-button unlock-signout" onClick={onLogout}>Sign out instead</button><SimulationTag /></main>
}

export default App