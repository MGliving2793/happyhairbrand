import React, { useState, useEffect } from 'react';

const TrackingBanner = () => {
  const [orderId, setOrderId] = useState(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const savedOrder = localStorage.getItem('happy_hair_recent_order');
    if (savedOrder) {
      setOrderId(savedOrder);
      setIsVisible(true);
    }
  }, []);

  if (!isVisible) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: '24px',
      left: '24px',
      backgroundColor: '#fff',
      boxShadow: '0 10px 40px -10px rgba(0,0,0,0.2)',
      borderRadius: '16px',
      padding: '16px 24px',
      zIndex: 999999,
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      border: '1px solid #f0ebe1',
      fontFamily: "'Plus Jakarta Sans', sans-serif"
    }}>
      <div style={{
        backgroundColor: '#fef3c7',
        width: '40px',
        height: '40px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '20px'
      }}>
        📦
      </div>
      <div>
        <div style={{ fontWeight: 700, color: '#3d2f25', fontSize: '15px' }}>Active Order Found</div>
        <div style={{ color: '#6b7280', fontSize: '13px', marginTop: '2px' }}>Track your recent purchase</div>
      </div>
      <a 
        href={`/api/orders/status/${orderId}`}
        style={{
          backgroundColor: '#523b31',
          color: '#fff',
          textDecoration: 'none',
          padding: '10px 16px',
          borderRadius: '8px',
          fontWeight: 600,
          fontSize: '13px',
          marginLeft: '8px',
          transition: 'background 0.2s'
        }}
      >
        Track Order
      </a>
      <button 
        onClick={() => setIsVisible(false)}
        style={{
          background: 'none',
          border: 'none',
          color: '#9ca3af',
          cursor: 'pointer',
          fontSize: '18px',
          marginLeft: '4px',
          padding: '4px'
        }}
      >
        &times;
      </button>
    </div>
  );
};

export default TrackingBanner;
