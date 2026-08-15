<#
Final patch script — writes frontend files updated for UPI auto-claim flow.
Usage:
  cd "C:\Users\HP\Documents\final web"
  powershell -ExecutionPolicy Bypass -File .\files\happyhair_payment_patch_final.ps1
#>

$files = @{
  'frontend\src\UPIAutoClaim.jsx' = @'
import React, { useState } from 'react';

export default function UPIAutoClaim({ orderId, onComplete }) {
  const [utr, setUtr] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const claim = async () => {
    if (!utr || utr.trim().length < 3) {
      setMessage({ type: 'error', text: 'Please enter a valid UPI reference/UTR.' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/claim-upi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upi_utr: utr.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: data.message || 'UPI UTR claimed successfully.' });
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to claim UPI reference.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error while claiming UPI.' });
    } finally {
      setLoading(false);
    }
  };

  const confirmAndDispatch = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/orders/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: data.message || 'Order approved and dispatched.' });
        if (typeof onComplete === 'function') {
          setTimeout(() => onComplete(), 800);
        }
      } else {
        setMessage({ type: 'error', text: data.error || 'Failed to approve order.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network error while approving order.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 12, background: '#fff6e6', borderRadius: 8, border: '1px solid #f1d9b3' }}>
      <div style={{ marginBottom: 8, fontWeight: 'bold' }}>Claim UPI Payment (Order #{orderId})</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input placeholder="Enter UPI transaction ref / UTR" value={utr} onChange={(e) => setUtr(e.target.value)} style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ddd' }} />
        <button onClick={claim} disabled={loading} style={{ padding: '8px 12px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{loading ? 'Saving...' : 'Claim'}</button>
      </div>
      <div style={{ marginBottom: 8, fontSize: 13, color: '#444' }}>
        After you enter the UTR, the team can verify and dispatch the order. You can also click "Confirm and Dispatch" to attempt an immediate dispatch (use only if payment is completed).
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={confirmAndDispatch} disabled={loading} style={{ padding: '8px 12px', background: '#c96f2a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{loading ? 'Working...' : 'Confirm and Dispatch'}</button>
        <button onClick={() => { if (typeof onComplete === 'function') onComplete(); }} disabled={loading} style={{ padding: '8px 12px', background: '#eee', color: '#111', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Close</button>
      </div>
      {message && (
        <div style={{ marginTop: 10, color: message.type === 'error' ? '#b00020' : '#1b5e20' }}>{message.text}</div>
      )}
    </div>
  );
}
'@

  'frontend\src\Checkout.jsx' = @'
import React, { useState, useEffect } from 'react';
import './Checkout.css';
import UPIAutoClaim from './UPIAutoClaim';

const indianLocations = {
  "Andaman and Nicobar Islands": ["Port Blair", "Nicobar", "South Andaman", "North and Middle Andaman"],
  "Andhra Pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Tirupati", "Kurnool", "Rajahmundry", "Anantapur", "Kadapa", "Eluru"],
  "Arunachal Pradesh": ["Itanagar", "Tawang", "Ziro", "Pasighat", "Roing", "Tezu"],
  "Assam": ["Guwahati", "Silchar", "Dibrugarh", "Jorhat", "Nagaon", "Tinsukia", "Tezpur", "Bongaigaon"],
  "Bihar": ["Patna", "Gaya", "Bhagalpur", "Muzaffarpur", "Purnia", "Darbhanga", "Ara", "Begusarai", "Katihar", "Chapra"],
  "Chandigarh": ["Chandigarh"],
  "Chhattisgarh": ["Raipur", "Bhilai", "Bilaspur", "Korba", "Durg", "Rajnandgaon", "Raigarh", "Jagdalpur"],
  "Dadra and Nagar Haveli and Daman and Diu": ["Daman", "Diu", "Silvassa"],
  "Delhi": ["New Delhi", "North Delhi", "South Delhi", "East Delhi", "West Delhi", "Central Delhi"],
  "Goa": ["Panaji", "Margao", "Vasco da Gama", "Mapusa", "Ponda"],
  "Gujarat": ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Bhavnagar", "Jamnagar", "Gandhinagar", "Junagadh", "Anand", "Navsari"],
  "Haryana": ["Faridabad", "Gurugram", "Panipat", "Ambala", "Yamunanagar", "Rohtak", "Hisar", "Karnal", "Sonipat", "Panchkula"],
  "Himachal Pradesh": ["Shimla", "Mandi", "Dharamshala", "Solan", "Kullu", "Manali"],
  "Jammu and Kashmir": ["Srinagar", "Jammu", "Anantnag", "Baramulla", "Kathua"],
  "Jharkhand": ["Ranchi", "Jamshedpur", "Dhanbad", "Bokaro", "Deoghar", "Hazaribagh", "Giridih"],
  "Karnataka": ["Bengaluru", "Mysuru", "Hubballi-Dharwad", "Mangaluru", "Belagavi", "Davangere", "Ballari", "Tumakuru", "Shivamogga", "Udupi"],
  "Kerala": ["Thiruvananthapuram", "Kochi", "Kozhikode", "Thrissur", "Kollam", "Alappuzha", "Palakkad", "Kannur", "Kottayam"],
  "Ladakh": ["Leh", "Kargil"],
  "Lakshadweep": ["Kavaratti"],
  "Madhya Pradesh": ["Indore", "Bhopal", "Jabalpur", "Gwalior", "Ujjain", "Sagar", "Rewa", "Satna", "Ratlam", "Singrauli"],
  "Maharashtra": ["Mumbai", "Pune", "Nagpur", "Thane", "Nashik", "Kalyan-Dombivli", "Vasai-Virar", "Aurangabad", "Navi Mumbai", "Solapur", "Amravati"],
  "Manipur": ["Imphal", "Thoubal", "Bishnupur", "Churachandpur"],
  "Meghalaya": ["Shillong", "Tura", "Jowai"],
  "Mizoram": ["Aizawl", "Lunglei", "Champhai"],
  "Nagaland": ["Kohima", "Dimapur", "Mokokchung"],
  "Odisha": ["Bhubaneswar", "Cuttack", "Rourkela", "Brahmapur", "Sambalpur", "Puri", "Balasore", "Bhadrak", "Baripada"],
  "Puducherry": ["Puducherry", "Oulgaret", "Karaikal", "Yanam", "Mahe"],
  "Punjab": ["Ludhiana", "Amritsar", "Jalandhar", "Patiala", "Bathinda", "Hoshiarpur", "Mohali", "Batala", "Pathankot"],
  "Rajasthan": ["Jaipur", "Jodhpur", "Kota", "Bikaner", "Ajmer", "Udaipur", "Bhilwara", "Alwar", "Sikar", "Pali"],
  "Sikkim": ["Gangtok", "Namchi", "Gyalshing", "Mangan"],
  "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli", "Salem", "Tirunelveli", "Tiruppur", "Erode", "Vellore", "Thoothukudi"],
  "Telangana": ["Hyderabad", "Warangal", "Nizamabad", "Karimnagar", "Ramagundam", "Khammam", "Mahbubnagar", "Nalgonda"],
  "Tripura": ["Agartala", "Dharmanagar", "Udaipur"],
  "Uttar Pradesh": ["Lucknow", "Kanpur", "Ghaziabad", "Agra", "Varanasi", "Meerut", "Prayagraj", "Bareilly", "Aligarh", "Moradabad", "Gorakhpur"],
  "Uttarakhand": ["Dehradun", "Haridwar", "Roorkee", "Haldwani", "Rudrapur", "Kashipur", "Rishikesh"],
  "West Bengal": ["Kolkata", "Asansol", "Siliguri", "Durgapur", "Bardhaman", "Malda", "Baharampur", "Shantipur", "Kharagpur", "Haldia"]
};

export default function Checkout({ isOpen, onClose, initialProduct }) {
  const [formData, setFormData] = useState(() => {
    try {
      const saved = localStorage.getItem('checkoutForm');
      return saved ? JSON.parse(saved) : { name: '', email: '', phone: '', address: '', state: '', city: '', pincode: '', paymode: 'UPI' };
    } catch (e) { return { name: '', email: '', phone: '', address: '', state: '', city: '', pincode: '', paymode: 'UPI' }; }
  });

**(truncated)**
