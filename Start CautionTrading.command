#!/bin/zsh
cd "$(dirname "$0")"
echo "Starting CautionTrading..."
open "http://localhost:8899"
exec npm start
