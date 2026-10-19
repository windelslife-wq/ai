import Link from "next/link";

const links = [
  ["Overview", "/"],
  ["Discover", "/app/leads"],
  ["Pipeline", "/app/lead-pipeline"],
  ["Intelligence", "/intelligence"],
  ["Collections", "/collections"],
] as const;

const linkClass = "shrink-0 rounded-md px-2 py-1.5 text-sm text-slate-400 transition hover:bg-slate-900 hover:text-cyan-300";
const mobileLinkClass = "shrink-0 rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-900 hover:text-cyan-200";

export function Navigation() {
  return (
    <nav aria-label="Main navigation" className="border-b border-slate-800 bg-slate-950/85 px-4 py-3 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="flex min-h-10 items-center justify-between gap-4">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-bold tracking-tight text-white">
            <img src="/images/windels-mark.png" alt="" className="h-8 w-8 rounded-lg object-cover" />
            WINDELS <span className="hidden font-normal text-slate-500 sm:inline">AI WORKFORCE</span>
          </Link>
          <div className="hidden items-center gap-1 lg:flex">
            {links.map(([label, href]) => <Link key={href} href={href} className={linkClass}>{label}</Link>)}
            <Link href="/account" className={linkClass}>Account</Link>
            <Link href="/login" className="ml-1 rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300">Sign in</Link>
          </div>
        </div>
        <div className="-mx-4 mt-3 overflow-x-auto sm:-mx-6 lg:hidden">
          <div className="flex min-w-max gap-2 px-4 pb-1 sm:px-6">
            {links.map(([label, href]) => <Link key={href} href={href} className={mobileLinkClass}>{label}</Link>)}
            <Link href="/account" className={mobileLinkClass}>Account</Link>
            <Link href="/login" className={mobileLinkClass}>Sign in</Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
