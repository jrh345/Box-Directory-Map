const { getState, setMapState } = require('./store');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).json({});
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json(getState());
    return;
  }

  if (req.method === 'PUT') {
    const next = setMapState(req.body || {});
    res.status(200).json(next);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
