import Link from "next/link";
const links = [["Overview", "/"], ["AI Workforce", "/app/leads"], ["Language", "/intelligence"], ["Leads", "/collections"], ["Trading", "/app/lead-pipeline"]] as const;
export function Navigation() {
  return (
    <nav className="border-b border-slate-800 bg-slate-950/85 px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-bold tracking-tight text-white">
          <img src="/images/windels-mark.png" alt="WINDELS AI WORKFORCE" className="h-8 w-8 rounded-lg object-cover" />
          WINDELS <span className="hidden font-normal text-slate-500 sm:inline">AI WORKFORCE</span>
        </Link>
        <div className="hidden items-center gap-5 text-sm text-slate-400 lg:flex">
          {links.map(([label, href]) => (
            <Link key={href} href={href} className="transition hover:text-cyan-300">
              {label}
            </Link>
          ))}
          <Link href="/account" className="transition hover:text-cyan-300">
            Account
          </Link>
          <Link href="/login" className="text-cyan-300 transition hover:text-white">
            Sign in
          </Link>
        </div>
        <div className="flex gap-2 lg:hidden">
          <Link href="/app/leads" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300">
            Workforce
          </Link>
          <Link href="/account" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300">
            Account
          </Link>
        </div>
      </div>
    </nav>
  );
}
