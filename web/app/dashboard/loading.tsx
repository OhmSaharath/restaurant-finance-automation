export default function DashboardLoading() {
  return (
    <div className="min-h-screen flex bg-[#050505] text-slate-100 subtle-mesh-bg animate-pulse">
      {/* Skeleton Sidebar */}
      <aside className="w-64 border-r border-white/10 dark-glass p-5 min-h-screen fixed left-0 top-0 z-20 hidden md:flex flex-col justify-between">
        <div className="space-y-6">
          <div className="flex items-center gap-3 px-2 py-3">
            <div className="w-10 h-10 rounded-2xl bg-white/10" />
            <div className="space-y-2">
              <div className="w-28 h-4 bg-white/10 rounded" />
              <div className="w-16 h-3 bg-white/5 rounded" />
            </div>
          </div>
          <div className="space-y-2 pt-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="w-full h-10 bg-white/5 rounded-2xl" />
            ))}
          </div>
        </div>
      </aside>

      {/* Main Skeleton Content */}
      <main className="flex-1 w-full md:ml-64 px-4 md:px-8 py-6 space-y-8">
        {/* Header Skeleton */}
        <div className="h-24 bg-white/5 border border-white/10 dark-glass rounded-3xl" />

        {/* 4 KPI Cards Skeleton */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-36 bg-white/5 border border-white/10 dark-glass rounded-3xl" />
          ))}
        </div>

        {/* Carousel & Map Skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 h-72 bg-white/5 border border-white/10 dark-glass rounded-3xl" />
          <div className="lg:col-span-1 h-72 bg-white/5 border border-white/10 dark-glass rounded-3xl" />
        </div>

        {/* Analytics Grid Skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 h-80 bg-white/5 border border-white/10 dark-glass rounded-3xl" />
          <div className="lg:col-span-1 h-80 bg-white/5 border border-white/10 dark-glass rounded-3xl" />
        </div>
      </main>
    </div>
  );
}
