import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './Layout';
import Login from './Login';
import Orders from './Orders';
import Products from './Products';

function App() {
  const [authenticated, setAuthenticated] = useState(!!localStorage.getItem('adminToken'));

  return (
    <BrowserRouter basename="/dashboard">
      <Routes>
        <Route 
          path="/login" 
          element={!authenticated ? <Login setAuthenticated={setAuthenticated} /> : <Navigate to="/orders" />} 
        />
        
        <Route 
          path="/" 
          element={authenticated ? <Layout setAuthenticated={setAuthenticated} /> : <Navigate to="/login" />}
        >
          <Route index element={<Navigate to="/orders" />} />
          <Route path="orders" element={<Orders />} />
          <Route path="products" element={<Products />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
