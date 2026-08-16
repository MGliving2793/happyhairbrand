import { useEffect, useState } from 'react';
import api from './api';
import { Plus, Trash2 } from 'lucide-react';

export default function Products() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Form State
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      const res = await api.get('/products');
      setProducts(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    try {
      await api.post('/products', {
        title,
        price: parseFloat(price),
        image_url: imageUrl,
        description
      });
      setShowForm(false);
      setTitle(''); setPrice(''); setImageUrl(''); setDescription('');
      fetchProducts();
    } catch (err) {
      alert('Failed to add product');
      console.error(err);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this product?')) return;
    try {
      await api.delete(`/products/${id}`);
      fetchProducts();
    } catch (err) {
      alert('Failed to delete product');
      console.error(err);
    }
  };

  if (loading) return <div className="text-gray-500">Loading products...</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-[var(--color-royal-dark)]">Products</h1>
        <button 
          onClick={() => setShowForm(!showForm)}
          className="bg-[var(--color-royal-dark)] text-white px-5 py-2.5 rounded-xl font-medium shadow flex items-center gap-2 hover:bg-[var(--color-royal-light)] transition-colors"
        >
          <Plus className="w-5 h-5" /> Add Product
        </button>
      </div>

      {showForm && (
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 mb-8">
          <h2 className="text-xl font-bold text-[var(--color-royal-dark)] mb-6">Add New Product</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-2 gap-6">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-sm font-medium text-gray-700 mb-2">Title</label>
              <input type="text" required value={title} onChange={e => setTitle(e.target.value)} className="w-full px-4 py-2 rounded-lg border border-gray-200 outline-none focus:border-[var(--color-royal-accent)] focus:ring-1 focus:ring-[var(--color-royal-accent)]" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-sm font-medium text-gray-700 mb-2">Price (₹)</label>
              <input type="number" required value={price} onChange={e => setPrice(e.target.value)} className="w-full px-4 py-2 rounded-lg border border-gray-200 outline-none focus:border-[var(--color-royal-accent)] focus:ring-1 focus:ring-[var(--color-royal-accent)]" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">Image URL</label>
              <input type="text" value={imageUrl} onChange={e => setImageUrl(e.target.value)} className="w-full px-4 py-2 rounded-lg border border-gray-200 outline-none focus:border-[var(--color-royal-accent)] focus:ring-1 focus:ring-[var(--color-royal-accent)]" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full px-4 py-2 rounded-lg border border-gray-200 outline-none focus:border-[var(--color-royal-accent)] focus:ring-1 focus:ring-[var(--color-royal-accent)]" rows="3" />
            </div>
            <div className="col-span-2 flex justify-end gap-3">
              <button type="button" onClick={() => setShowForm(false)} className="px-5 py-2 rounded-lg text-gray-500 font-medium hover:bg-gray-50">Cancel</button>
              <button type="submit" className="bg-[var(--color-royal-dark)] text-white px-5 py-2 rounded-lg font-medium shadow hover:bg-[var(--color-royal-light)]">Save Product</button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {products.map(product => (
          <div key={product.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
            <div className="h-48 bg-gray-100 relative">
              {product.image_url ? (
                <img src={product.image_url} alt={product.title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">No Image</div>
              )}
            </div>
            <div className="p-5 flex-1 flex flex-col">
              <h3 className="font-bold text-gray-900 mb-1">{product.title}</h3>
              <p className="text-2xl font-bold text-[var(--color-royal-dark)] mb-4">₹{product.price}</p>
              <div className="mt-auto flex justify-end">
                <button 
                  onClick={() => handleDelete(product.id)}
                  className="text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors flex items-center gap-2 text-sm font-medium"
                >
                  <Trash2 className="w-4 h-4" /> Delete
                </button>
              </div>
            </div>
          </div>
        ))}
        {products.length === 0 && <div className="col-span-3 text-center text-gray-500 py-12 bg-white rounded-2xl border border-gray-100">No products found.</div>}
      </div>
    </div>
  );
}
