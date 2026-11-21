/**
 * The persistent frame around every page except AR: a left rail on wide screens,
 * a bottom tab bar on phones, plus app-wide toasts (update ready, offline).
 *
 * Also kicks off first-run sample seeding, so the library is never empty on a
 * fresh install.
 */
import { Suspense, useEffect } from "react";
import { NavLink, Outlet, useNavigation } from "react-router-dom";
import { LogoMark, Wordmark } from "@/components/Logo";
import { seedSamplesOnce } from "@/lib/db/samples";
import { useSettings } from "@/stores/settings";
import { NavIcon, type NavIconName } from "./NavIcon";
import { OfflineBadge } from "./OfflineBadge";
import { UpdateToast } from "./UpdateToast";
import styles from "./AppShell.module.css";

interface NavItem {
  to: string;
  label: string;
  icon: NavIconName;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Projects", icon: "projects", end: true },
  { to: "/new", label: "New", icon: "new" },
  { to: "/map", label: "Live map", icon: "map" },
  { to: "/learn", label: "How it works", icon: "learn" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export function AppShell() {
  const navigation = useNavigation();
  const demoMode = useSettings((s) => s.demoMode);

  useEffect(() => {
    // Fire-and-forget; a failure (e.g. offline on very first launch) retries next launch.
    seedSamplesOnce().catch((e) => console.warn("[samples] seeding failed:", e));
  }, []);

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <nav className={styles.nav} aria-label="Main">
        <div className={styles.brand}>
          <LogoMark className={styles.mark} />
          <Wordmark />
        </div>
        <ul>
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className={({ isActive }) => (isActive ? styles.active : undefined)}>
                <NavIcon name={item.icon} />
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className={styles.status}>
          {demoMode && <span className={styles.demo}>Demo mode</span>}
          <OfflineBadge />
        </div>
      </nav>
      <main id="main" className={styles.main} aria-busy={navigation.state === "loading"}>
        {navigation.state === "loading" && <div className={styles.routeProgress} role="progressbar" aria-label="Loading page" />}
        {/* Phones have no rail, so the offline notice gets a strip of its own (empty, and hidden, while online). */}
        <div className={styles.phoneStatus}>
          <OfflineBadge />
        </div>
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
      <UpdateToast />
    </div>
  );
}
