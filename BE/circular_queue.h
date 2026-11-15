#pragma once

#include <array>
#include <cstddef>
#include <stdexcept>

template <typename T, std::size_t Capacity>
class CircularQueue
{
    static_assert(Capacity > 0, "CircularQueue capacity must be positive");

public:
    void clear()
    {
        head_ = 0;
        size_ = 0;
    }

    std::size_t size() const
    {
        return size_;
    }

    void push(const T &value)
    {
        if (size_ < Capacity)
        {
            data_[(head_ + size_) % Capacity] = value;
            ++size_;
            return;
        }

        data_[head_] = value;
        head_ = (head_ + 1) % Capacity;
    }

    T &operator[](std::size_t index)
    {
        if (index >= size_)
            throw std::out_of_range("CircularQueue index out of range");
        return data_[(head_ + index) % Capacity];
    }

    const T &operator[](std::size_t index) const
    {
        if (index >= size_)
            throw std::out_of_range("CircularQueue index out of range");
        return data_[(head_ + index) % Capacity];
    }

private:
    std::array<T, Capacity> data_{};
    std::size_t head_ = 0;
    std::size_t size_ = 0;
};
