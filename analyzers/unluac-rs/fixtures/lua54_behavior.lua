local function absolute(value)
  if value < 0 then
    return -value
  end
  return value
end

local function weighted_sum(values)
  local total = 0
  for index = 1, #values do
    total = total + absolute(values[index]) * index
  end
  return total
end

local input = tonumber(arg[1]) or 3
print(weighted_sum({ input, -2, 5 }))
