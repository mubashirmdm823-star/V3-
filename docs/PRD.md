# FoodHub AI

## Project Goal

Build a Restaurant WhatsApp Ordering SaaS.

Customers interact using WhatsApp.

Restaurant staff manage orders through a dashboard.

Kitchen staff process confirmed orders through a kitchen board.

The system must support future multi-restaurant SaaS architecture.

---

## Core Requirement

Orders must NOT automatically reach the kitchen.

Every order must first go to:

Pending Verification

A staff member calls the customer.

After phone verification:

Confirm Order

or

Reject Order

Only confirmed orders reach the kitchen.

---

## Customer Flow

Customer sends WhatsApp message

↓

Menu shown

↓

Customer selects item

↓

Customer enters quantity

↓

Customer enters delivery/pickup

↓

Customer enters address

↓

Order created

↓

Pending Verification

↓

Customer receives:

"Your order is pending verification"

↓

Staff calls customer

↓

Order confirmed

↓

Kitchen receives order

---

## Admin Flow

Receive new order notification

↓

View order

↓

Call customer

↓

Confirm or Reject

↓

Customer receives update

---

## Kitchen Flow

Confirmed

↓

Preparing

↓

Ready

↓

Delivered

---

## Demo Objective

Build a working clickable prototype.

Backend not required initially.

Database not required initially.

Use mock data and local state.

Architecture must be ready for future Supabase integration.
