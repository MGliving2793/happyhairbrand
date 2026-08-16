import { useEffect, useState } from 'react';
import api from './api';
import { ChevronDown, ChevronUp, PackageCheck, MapPin } from 'lucide-react';

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    try {
      const res = await api.get('/orders');
      setOrders(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleRow = (id) => {
    setExpanded(expanded === id ? null : id);
  };

  if (loading) return <div className="text-gray-500">Loading orders...</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-[var(--color-royal-dark)]">Recent Orders</h1>
        <div className="bg-[var(--color-royal-accent)] text-[var(--color-royal-dark)] px-4 py-2 rounded-lg font-bold shadow">
          {orders.length} Total
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100 text-gray-500 text-sm">
              <th className="p-4 font-medium">Order ID</th>
              <th className="p-4 font-medium">Customer</th>
              <th className="p-4 font-medium">Amount</th>
              <th className="p-4 font-medium">Payment</th>
              <th className="p-4 font-medium">Status</th>
              <th className="p-4 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {orders.map(order => (
              <React.Fragment key={order.id}>
                <tr 
                  className={`hover:bg-gray-50 cursor-pointer transition-colors ${expanded === order.id ? 'bg-gray-50' : ''}`}
                  onClick={() => toggleRow(order.id)}
                >
                  <td className="p-4 font-medium text-gray-900">#{order.id}</td>
                  <td className="p-4">
                    <div className="font-medium text-gray-900">{order.customer_name}</div>
                    <div className="text-sm text-gray-500">{order.phone}</div>
                  </td>
                  <td className="p-4 font-medium text-gray-900">₹{order.total}</td>
                  <td className="p-4">
                    <span className={`px-3 py-1 rounded-full text-xs font-bold ${order.pay_mode === 'PREPAID' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                      {order.pay_mode}
                    </span>
                  </td>
                  <td className="p-4">
                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                      {order.status}
                    </span>
                  </td>
                  <td className="p-4 text-right text-gray-400">
                    {expanded === order.id ? <ChevronUp className="inline w-5 h-5" /> : <ChevronDown className="inline w-5 h-5" />}
                  </td>
                </tr>
                {expanded === order.id && (
                  <tr className="bg-gray-50/50">
                    <td colSpan="6" className="p-6">
                      <div className="grid grid-cols-2 gap-8">
                        <div>
                          <h4 className="text-sm font-bold text-gray-500 flex items-center gap-2 mb-3 uppercase tracking-wider">
                            <MapPin className="w-4 h-4" /> Shipping Address
                          </h4>
                          <p className="text-gray-900">{order.address}</p>
                          <p className="text-gray-900">{order.city}, {order.state} {order.pincode}</p>
                          <p className="text-gray-500 mt-2">{order.email}</p>
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-gray-500 flex items-center gap-2 mb-3 uppercase tracking-wider">
                            <PackageCheck className="w-4 h-4" /> Order Details
                          </h4>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between"><span className="text-gray-500">Date:</span> <span className="font-medium">{new Date(order.createdAt).toLocaleString()}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Order No:</span> <span className="font-medium">{order.order_no || '-'}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">UTR:</span> <span className="font-medium">{order.utr || '-'}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Coupon:</span> <span className="font-medium">{order.coupon_code || '-'}</span></div>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <div className="p-8 text-center text-gray-500">No orders found.</div>}
      </div>
    </div>
  );
}
