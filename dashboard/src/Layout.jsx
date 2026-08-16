import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { Package, ShoppingBag, LogOut, LayoutDashboard } from 'lucide-react';

export default function Layout({ setAuthenticated }) {
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    setAuthenticated(false);
    navigate('/login');
  };

  const menu = [
    { name: 'Orders', path: '/orders', icon: ShoppingBag },
    { name: 'Products', path: '/products', icon: Package },
  ];

  return (
    <div className="flex h-screen bg-[var(--color-royal-bg)]">
      {/* Sidebar Drawer */}
      <aside className="w-64 bg-[var(--color-royal-dark)] text-white flex flex-col shadow-2xl z-10">
        <div className="p-6 flex items-center gap-3">
          <LayoutDashboard className="text-[var(--color-royal-accent)] w-8 h-8" />
          <h2 className="text-2xl font-semibold tracking-wide text-[var(--color-royal-accent)]">Royal</h2>
        </div>
        
        <nav className="flex-1 px-4 mt-6 space-y-2">
          {menu.map((item) => {
            const active = location.pathname === item.path;
            const Icon = item.icon;
            return (
              <Link 
                key={item.name} 
                to={item.path}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${active ? 'bg-[var(--color-royal-accent)] text-[var(--color-royal-dark)] shadow-lg' : 'hover:bg-[var(--color-royal-light)] text-gray-200'}`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium">{item.name}</span>
              </Link>
            )
          })}
        </nav>

        <div className="p-4 border-t border-[var(--color-royal-light)]">
          <button 
            onClick={handleLogout}
            className="flex items-center gap-3 px-4 py-3 w-full text-left rounded-xl hover:bg-red-500/20 text-red-300 transition-all"
          >
            <LogOut className="w-5 h-5" />
            <span className="font-medium">Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto p-8 relative">
        <div className="max-w-6xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
