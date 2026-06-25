# FoodHub AI WhatsApp Flow

## Main Concept

FoodHub AI will work through the restaurant's WhatsApp Business number.

The customer will message the restaurant's WhatsApp number.

The AI will talk to the customer, answer menu questions, suggest deals, build the order, collect delivery or pickup details, and create an order with Pending Verification status.

The order will not go to the kitchen until staff calls the customer and confirms it.

---

# Smart AI Behaviour

## AI Will Handle

Menu questions

Prices

Deals

Add ons

Budget based suggestions

Popular item recommendations

Delivery charges

Restaurant timings

Order taking

Order summary

Checkout

Unknown questions escalation

---

## AI Must Not Do

Invent prices

Invent fake deals

Confirm orders without staff verification

Send pending orders to kitchen

Answer off topic questions

Give medical, legal, political or unrelated advice

---

# AI Knowledge Required

The AI must be connected to restaurant data.

Required data:

Menu items

Item prices

Categories

Deals

Combo meals

Add ons

Popular items

Delivery charges

Minimum order amount

Restaurant timings

Payment methods

Delivery areas

Branch details

Staff escalation rules

---

# Customer Conversation Flow

## Step 1: Customer Starts Chat

Customer:

Hi

AI:

Welcome to FoodHub AI.

How can I help you today?

1. View Menu
2. Today's Deals
3. Place an Order
4. Track My Order
5. Speak to Staff

---

## Step 2: Menu Question

Customer:

Mujhe sirf Zinger ka batao

AI:

Here are our Zinger options:

1. Classic Zinger - PKR 549
2. Dynamite Zinger - PKR 649
3. Cheese Zinger - PKR 699

Our most popular option is Dynamite Zinger.

Would you like to order one?

---

## Step 3: Smart Deal Suggestion

Customer:

Mujhe 1 Zinger aur 1 Coke chahiye

AI checks menu and deals.

If a better deal exists:

AI:

You selected:

1 x Zinger
1 x Coke

A better deal is available:

Deal 3 includes:
1 x Zinger
1 x Fries
1 x Coke

Price: PKR 849

You can get fries included for a better value.

Would you like to choose Deal 3 instead?

1. Yes, choose Deal 3
2. No, continue with Zinger and Coke

---

## Step 4: Customer Chooses Deal

Customer:

1

AI:

Great. Deal 3 has been added to your order.

Current Order:

1 x Deal 3
Includes:
1 x Zinger
1 x Fries
1 x Coke

Total: PKR 849

Would you like to add anything else?

1. Add More Items
2. Checkout

---

## Step 5: Add More Items

Customer:

Add one more Coke

AI:

Added:

1 x Coke

Updated Order:

1 x Deal 3 - PKR 849
1 x Coke - PKR 150

Subtotal: PKR 999

Would you like to add anything else?

1. Add More Items
2. Checkout

---

## Step 6: Budget Based Recommendation

Customer:

Mere paas PKR 1500 ka budget hai

AI:

Based on your PKR 1500 budget, I recommend:

2 x Dynamite Zinger
1 x Fries
2 x Coke

Estimated Total: PKR 1448

Would you like to continue with this order?

1. Yes
2. Show more options

---

# Checkout Flow

## Step 1: Delivery or Pickup

AI:

Would you like Delivery or Pickup?

1. Delivery
2. Pickup

---

## Step 2A: Delivery

Customer:

Delivery

AI:

Please share your delivery address.

---

Customer:

DHA Karachi, Street 12, House 45

AI:

Please share your name.

---

Customer:

Ali Khan

AI:

Please share any special instructions.

You can type No if there are no instructions.

---

Customer:

No

AI:

Order Summary

Customer: Ali Khan
Order:
1 x Deal 3 - PKR 849
1 x Coke - PKR 150

Subtotal: PKR 999
Delivery Fee: PKR 150
Total: PKR 1149

Delivery Address:
DHA Karachi, Street 12, House 45

Status after submission:
Pending Verification

Our staff will call you before confirming the order.

Reply YES to submit your order.

---

## Step 2B: Pickup

Customer:

Pickup

AI:

Please share your name.

---

Customer:

Ali Khan

AI:

Order Summary

Customer: Ali Khan
Order:
1 x Deal 3 - PKR 849

Total: PKR 849

Pickup Time:
15 to 20 minutes after confirmation

Status after submission:
Pending Verification

Our staff will call you before confirming the order.

Reply YES to submit your order.

---

# Order Submission

Customer:

YES

AI:

Your order has been received.

Order Number: #1021
Status: Pending Verification

Our team will call you shortly to confirm your order.

---

# Admin WhatsApp Notification

When an order is submitted, admin receives a WhatsApp alert.

Admin Message:

New Order Received

Order Number: #1021
Customer: Ali Khan
Phone: 03XXXXXXXXX

Items:
1 x Deal 3
1 x Coke

Total: PKR 1149

Status:
Pending Verification

Action Required:
Please call the customer and verify this order.

---

# Admin Dashboard Flow

The order appears in:

Pending Verification

Admin sees:

Order number

Customer name

Phone number

Items

Total

Address

Order type

Notes

Time

Status

Buttons:

Call Customer

Confirm Order

Reject Order

---

# Confirmation Rule

The order must stay Pending Verification until staff verifies it by phone.

Kitchen must not see Pending Verification orders.

---

# If Admin Confirms

Admin clicks:

Confirm Order

System updates:

Order Status: Confirmed

Customer receives WhatsApp message:

Your order has been confirmed.

Order Number: #1021

Estimated delivery time:
45 minutes

Your food is now being prepared.

Kitchen receives the order.

---

# If Admin Rejects

Admin clicks:

Reject Order

System updates:

Order Status: Rejected

Customer receives WhatsApp message:

Your order could not be confirmed.

Please contact the restaurant for further assistance.

Kitchen does not receive the order.

---

# Kitchen Flow

Kitchen only sees confirmed orders.

Kitchen statuses:

Confirmed

Preparing

Ready

Delivered

---

# Customer Status Updates

When kitchen changes status:

Preparing

AI sends:

Your order is now being prepared.

---

Ready

AI sends:

Your order is ready.

---

Delivered

AI sends:

Your order has been delivered.

Thank you for ordering from FoodHub AI.

---

# Unknown Question Handling

If customer asks something that is not in restaurant data:

Customer:

Do you do wedding catering?

AI:

I do not have confirmed information about this.

I am forwarding your question to our staff, and they will guide you shortly.

---

# Off Topic Handling

If customer asks unrelated questions:

Customer:

Cricket score kya hai?

AI:

I can help only with restaurant menu, deals, orders, delivery, pickup and support.

Would you like to view our menu?

---

# Demo Version Rules

For the first client demo:

No real WhatsApp API

No real database

No real backend

Use a WhatsApp chat simulator

Use mock restaurant data

Use React state

Show smart AI suggestions

Show deal recommendation

Show order summary

Show admin notification

Show Pending Verification

Show Confirm and Reject flow

Show kitchen update after confirmation

---

# Production Version Rules

For production:

Use Meta WhatsApp Cloud API

Use webhook to receive messages

Use AI/order parser to understand customer messages

Use Supabase to store orders

Use dashboard to verify orders

Use WhatsApp Cloud API to send customer and admin notifications

Use strict business rules

Never send unverified orders to kitchen

Never invent prices or deals
