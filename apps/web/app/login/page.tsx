export const dynamic = "force-dynamic";

export default function LoginPage() {
  const mock = (process.env.AUTH_MODE ?? process.env.NEXT_PUBLIC_AUTH_MODE ?? "mock") === "mock";
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand brand-large"><span className="brand-mark">A</span> ARGUS</div>
        <p className="eyebrow">Distributed uptime intelligence</p>
        <h1>Know before your customers do.</h1>
        <p className="lede">Watch every service from every region, then put the right responder in motion.</p>
        <a className="primary-button login-button" href="/api/auth/login">
          {mock ? "Continue as local developer" : "Sign in with Argus"}
        </a>
        {mock && <p className="login-note">Development identity is isolated from staging and production.</p>}
      </section>
      <aside className="signal-panel" aria-label="Argus signal preview">
        <div className="signal-grid" />
        <div className="orb orb-one" />
        <div className="orb orb-two" />
        <div className="signal-card">
          <span className="live-dot" /> Three regions reporting
          <strong>99.99%</strong>
          <small>Global availability</small>
        </div>
      </aside>
    </main>
  );
}
