# FoodHub AI Database Design

## restaurants

id

name

owner_name

phone

email

subscription_plan

created_at

---

## users

id

restaurant_id

name

email

role

created_at

---

## customers

id

restaurant_id

name

phone

email

total_orders

total_spent

segment

created_at

---

## categories

id

restaurant_id

name

sort_order

created_at

---

## menu_items

id

restaurant_id

category_id

name

description

price

image

is_available

created_at

---

## orders

id

restaurant_id

customer_id

order_number

status

verification_status

order_type

subtotal

delivery_fee

total

created_at

---

## order_items

id

order_id

menu_item_id

quantity

price

total

created_at

---

## notifications

id

restaurant_id

type

title

message

is_read

created_at

---

## whatsapp_messages

id

customer_id

message_type

message

status

created_at
