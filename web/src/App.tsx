import { useEffect, useState } from 'react';
import { hasSession, signOut } from './api';
import { Compare } from './screens/Compare';
import { FindPlans } from './screens/FindPlans';
import { Home } from './screens/Home';
import { LinkPolicy } from './screens/LinkPolicy';
import { Messages } from './screens/Messages';
import { Pay } from './screens/Pay';
import { PlanDetail } from './screens/PlanDetail';
import { Receipt } from './screens/Receipt';
import { SignIn } from './screens/SignIn';

/** Hash routes keep the app a single static page: #/, #/link, #/pay/<policy>, #/payments/<id>, #/messages,
 * and the public #/plans, #/plans/<id> and #/compare/<ids>, which work signed out. */
function useRoute(): [string[], (to: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (to: string) => (window.location.hash = to)];
}

export function App() {
  const [signedIn, setSignedIn] = useState(hasSession());
  const [route, go] = useRoute();

  const content = route[0] === 'plans' && route[1] ? (
    <PlanDetail key={route[1]} planId={route[1]} signedIn={signedIn} onSignedIn={() => setSignedIn(true)} go={go} />
  ) : route[0] === 'plans' ? (
    <FindPlans go={go} />
  ) : route[0] === 'compare' && route[1] ? (
    <Compare ids={route[1]} go={go} />
  ) : !signedIn ? (
    <SignIn onSignedIn={() => setSignedIn(true)} />
  ) : route[0] === 'link' ? (
    <LinkPolicy go={go} />
  ) : route[0] === 'pay' && route[1] ? (
    <Pay policyLinkId={route[1]} go={go} />
  ) : route[0] === 'payments' && route[1] ? (
    <Receipt paymentId={route[1]} go={go} />
  ) : route[0] === 'messages' ? (
    <Messages go={go} />
  ) : (
    <Home go={go} onSignedOut={() => setSignedIn(false)} />
  );

  return (
    <div className="app">
      <div className="sandbox" role="note">
        Test version. No real money moves and no real cover is affected.
      </div>
      <header className="bar">
        <a href="#/" className="brand" aria-label="AfyaPay home">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>AfyaPay</span>
        </a>
        <nav className="bar-nav">
          <a href="#/plans">Find insurance</a>
          {signedIn && <a href="#/messages">Messages</a>}
          {signedIn && (
            <button
              type="button"
              className="link-button"
              onClick={async () => {
                await signOut();
                setSignedIn(false);
                go('/');
              }}
            >
              Sign out
            </button>
          )}
        </nav>
      </header>
      <main className="page">{content}</main>
      <footer className="foot">Payments go straight from M-Pesa to your insurer. AfyaPay never holds your money.</footer>
    </div>
  );
}
